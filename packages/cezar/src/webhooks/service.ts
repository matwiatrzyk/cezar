import { readTrackerAssociation } from '../tracker-association.ts';
import { canonicalTrackerLink } from './links.ts';
import { WebhookHistory, pageRecords } from './history.ts';
import { ManualOperations } from './operations.ts';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { z } from 'zod';
import type { UpdateWebhook, WebhookOperation, WebhookDelivery, WebhookDeliveriesPage, WebhookActivityPage, WebhookHistoryPage } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { runLifecycleSnapshot, type RunLifecycleObserver } from '../runs/lifecycle.ts';
import { readRunIndexDiagnostic } from '../runs/run-index.ts';
import { prepareStorage, atomicWrite, readState, discardCopiedState, cleanupInterruptedWrites } from './storage.ts';
import { acquireOwnership, type WebhookOwnership } from './ownership.ts';
import { EndpointRegistry, WebhookStateError } from './endpoints.ts';
import { Outbox } from './outbox.ts';
import { AdmissionRepository, terminalDelivery, type Admission, type DeliveryRecord } from './admission.ts';
import { freshness, transitionType, type FailureDisposition } from './lifecycle.ts';
import { redactSource, renderPayload } from './payload.ts';
import type { WebhookSource } from './source.ts';
import { ProjectLimits } from './limits.ts';
import { WebhookScheduler } from './scheduler.ts';
import { sendWebhook, retryAt, type SendResult, type WebhookSend } from './transport.ts';

const identitySchema = z.strictObject({ version: z.literal(1), instanceId: z.string(), root: z.string(), highWater: z.number().int().nonnegative(), resetReason: z.literal('copied_state').optional() });
const failureIndexSchema = z.strictObject({ version: z.literal(1), episodes: z.record(z.string(), z.strictObject({
  episodeId: z.string(), sequence: z.number().int().positive(), continuation: z.number().int().nonnegative(), since: z.string(),
  decisions: z.record(z.string(), z.strictObject({ manual: z.string().optional(), scheduled: z.string().optional() })),
})) });
type FailureIndex = z.infer<typeof failureIndexSchema>;
interface ManagerReadiness { isActive(id: string): boolean; hasScheduledAutoResume?(id: string): boolean }
export interface WebhookServiceOptions {
  root: string; dataDir: string; projectId: string; mode: 'local' | 'hosted'; serverPorts(): readonly number[];
  cockpitLink?: (projectId: string, taskId: string) => string | undefined;
  repository?: string; scheduler: WebhookScheduler; dryRun?: boolean; now?: () => number; send?: (input: WebhookSend) => Promise<SendResult>;
}
interface Candidate { admissionId: string; deliveryId: string }
interface Claim extends Candidate { token: string; revision: number; request: WebhookSend }
export const webhooksEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.CEZ_WEBHOOKS === '1';

/** Owns one canonical project only. Network waits never hold the mutation queue. */
export class WebhookService extends EventEmitter {
  private store?: RunStore;
  private manager?: ManagerReadiness;
  private ready = false;
  private stopped = false;
  private broken = false;
  private inFlight = false;
  private timer?: ReturnType<typeof setInterval>;
  private tail: Promise<unknown> = Promise.resolve();
  private attempts = new Set<Promise<void>>();
  private abort = new AbortController();
  private episodes = new Map<string, string>();
  private failures: FailureIndex;
  private failureDirty = false;
  private operations: ManualOperations;
  private adminActions: { action: string; receiverId: string; revision: number }[] = [];
  private currentAttempt?: { receiverId: string; controller: AbortController };
  private captureFailed = false;
  private nextMaintenance = 0;
  private readonly now: () => number;
  private readonly send: (input: WebhookSend) => Promise<SendResult>;
  private constructor(
    private readonly options: WebhookServiceOptions, private readonly directory: string,
    private readonly identity: z.infer<typeof identitySchema>, private readonly ownership: WebhookOwnership,
    readonly endpoints: EndpointRegistry, private readonly outbox: Outbox,
    private readonly admissions: AdmissionRepository, private readonly limits: ProjectLimits, private readonly history: WebhookHistory, failures: FailureIndex,
  ) {
    super();
    this.operations = new ManualOperations(endpoints, admissions, options.now ?? Date.now, (record, id) => record.source ? this.stateFor(record.source, record.deliveries.find(item => item.id === id)?.frozen) : { kind: 'ready' }, async (receiver, action, record) => {
      const host = new URL(receiver.url).hostname;
      if (action === 'test') {
        const queued = this.admissions.all().flatMap(record => record.deliveries).filter(delivery => delivery.eventType === 'webhook.test' && !terminalDelivery(delivery.status) && new URL(delivery.destination).hostname === host);
        if (queued.length >= 3) throw new WebhookStateError(429, 'Three tests are already queued for this host; wait for them to finish', this.now() + 60000);
      }
      const limit = await this.limits.take({ host, test: action === 'test', manualFailure: record?.source?.type === 'task.failed', preview: true }, this.now());
      if (!limit.allowed) throw new WebhookStateError(429, 'Webhook rate limit reached; try again after the cooldown', limit.retryAt);
    });
    this.now = options.now ?? Date.now; this.send = options.send ?? sendWebhook; this.failures = failures;
    const sources = [...admissions.all().flatMap(record => record.source ? [record.source] : []), ...outbox.sources()].sort((a, b) => a.sequence - b.sequence);
    for (const source of sources) this.restoreEpisode(source);
    for (const [id, episode] of Object.entries(failures.episodes)) this.episodes.set(id, episode.episodeId);
  }
  static async open(options: WebhookServiceOptions): Promise<WebhookService | undefined> {
    if (!webhooksEnabled()) return;
    if (!options.projectId || options.projectId === 'default') throw new WebhookStateError(503, 'Webhook project identity is unavailable');
    const directory = await prepareStorage(options.root, options.dataDir, options.dryRun === true);
    const root = realpathSync(options.root);
    const binding = await readState(directory, 'identity.json', identitySchema);
    const copied = binding !== undefined && binding.root !== root;
    const owner = await acquireOwnership(directory, copied);
    if (!owner) throw new WebhookStateError(503, 'Another process owns this project’s webhooks');
    try {
      if (copied) await discardCopiedState(directory);
      await cleanupInterruptedWrites(directory);
      const identity = await readState(directory, 'identity.json', identitySchema) ?? { version: 1 as const, instanceId: `inst_${randomUUID()}`, root, highWater: 0, ...(copied ? { resetReason: 'copied_state' as const } : {}) };
      if (identity.root !== root) throw new WebhookStateError(503, 'Webhook state belongs to a different project root');
      await atomicWrite(directory, 'identity.json', identity);
      let service: WebhookService | undefined;
      const assertOwner = () => { if (!owner.valid()) throw new WebhookStateError(503, 'Webhook ownership is unavailable'); };
      const registry = await EndpointRegistry.open(directory, { installationId: identity.instanceId, mode: options.mode,
        reserve: bytes => { if (bytes > 1024 * 1024) throw new WebhookStateError(503, 'Receiver storage capacity exhausted'); },
        highWater: () => service?.outbox.highWater ?? identity.highWater, now: options.now ?? Date.now, assertOwner,
        changed: (action, receiverId, revision) => { if (service) { service.adminActions.push({ action, receiverId, revision }); service.emit('change', service.endpoints.list().changeSequence); } },
      });
      const admissions = await AdmissionRepository.open(directory, { now: options.now ?? Date.now, assertOwner, repository: options.repository, secrets: () => registry.live().flatMap(receiver => [receiver.url, receiver.secret, ...(receiver.retired ? [receiver.retired.secret] : [])]) });
      const highWater = Math.max(identity.highWater, ...registry.live().map(receiver => receiver.activation?.sequence ?? 0), ...admissions.all().map(record => record.sourceSequence ?? 0));
      const outbox = await Outbox.open(directory, identity.instanceId, highWater);
      const failures = await readState(directory, 'failure-episodes.json', failureIndexSchema) ?? { version: 1 as const, episodes: {} };
      const limits = await ProjectLimits.open(directory);
      const history = await WebhookHistory.open(directory, options.now ?? Date.now);
      service = new WebhookService(options, directory, identity, owner, registry, outbox, admissions, limits, history, failures);
      await service.operations.recover();
      return service;
    } catch (error) { await owner.release(); throw error; }
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => { this.assertUsable();
      try { const value = await work(); await this.flushActions(); return value; }
      catch (error) { if (!(error instanceof WebhookStateError) && !(error instanceof z.ZodError)) this.broken = true; throw error; } });
    this.tail = result.catch(() => undefined); return result;
  }
  private assertUsable(): void {
    if (this.stopped || this.broken || !this.ownership.valid()) throw new WebhookStateError(503, 'Webhook service is unavailable');
  }
  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick().catch(() => { this.broken = true; this.emit('change', this.endpoints.list().changeSequence); }); }, 5000);
    this.timer.unref();
    void this.tick().catch(() => { this.broken = true; });
  }
  attach(store: RunStore, manager: ManagerReadiness, ready = false): void {
    this.store?.setLifecycleObserver(undefined); this.store = store; this.manager = manager; this.ready = ready;
    store.setLifecycleObserver(this.capture);
    this.retireEndedFailures();
  }
  setProjectId(id: string): void { if (id && id !== 'default') this.options.projectId = id; }
  markReady(): void { this.ready = true; }
  private restoreEpisode(source: WebhookSource): void {
    if (['task.attention_required', 'task.review_ready', 'task.failed'].includes(source.type)) this.episodes.set(source.snapshot.id, source.episodeId);
    if (source.type === 'task.failed' && (!this.failures.episodes[source.snapshot.id] || this.failures.episodes[source.snapshot.id]!.sequence < source.sequence && this.failures.episodes[source.snapshot.id]!.episodeId !== source.episodeId)) {
      this.failures.episodes[source.snapshot.id] = { episodeId: source.episodeId, sequence: source.sequence, continuation: source.snapshot.continuation, since: source.occurredAt, decisions: {} };
      this.failureDirty = true;
    }
  }
  private capture: RunLifecycleObserver = (before, after, cause) => {
    if (this.stopped || this.broken) return;
    const id = after?.id ?? before?.id;
    if (id && (!after || after.archived || after.status !== before?.status)) {
      this.episodes.delete(id);
      if ((!after || after.archived || after.status !== 'failed') && this.failures.episodes[id]) { delete this.failures.episodes[id]; this.failureDirty = true; }
    }
    if (cause === 'reconcile' || !before || !after || !this.endpoints.hasCapturingReceivers()) return;
    const type = transitionType(before, after); if (!type) return;
    try {
      this.assertUsable();
      const sequence = this.outbox.highWater + 1;
      const episodeId = type === 'task.failed' && before.status === 'failed' ? this.failures.episodes[after.id]?.episodeId : `${after.id}-${sequence}`;
      // A never-captured failure cannot acquire an invented historical episode on metadata clear.
      if (!episodeId) return;
      const secrets = this.endpoints.live().flatMap(receiver => [receiver.url, receiver.secret, ...(receiver.retired ? [receiver.retired.secret] : [])]);
      const source = redactSource({ cockpitUrl: this.options.mode === 'hosted' ? this.options.cockpitLink?.(this.options.projectId, after.id) : undefined, version: 1, id: `evt_${randomUUID()}`, sequence, installationId: this.identity.instanceId,
        projectId: this.options.projectId, previousStatus: before.status, episodeId, type, occurredAt: new Date(this.now()).toISOString(), mode: this.options.mode, snapshot: after }, secrets);
      if (this.outbox.append(source)) this.restoreEpisode(source);
    } catch { this.captureFailed = true; /* Task execution never depends on webhook persistence. */ }
  };
  private retireEndedFailures(): void {
    const disk = this.store ? undefined : readRunIndexDiagnostic(this.options.dataDir, this.options.root);
    if (this.store ? this.store.getIndexReadHealth().state !== 'complete' : disk?.state !== 'complete') return;
    for (const [id, episode] of Object.entries(this.failures.episodes)) {
      const run = this.store ? this.store.getRun(id) : disk?.runs.find(candidate => candidate.id === id);
      if (!run || run.archived || run.status !== 'failed' || runLifecycleSnapshot(run).continuation !== episode.continuation) {
        delete this.failures.episodes[id]; this.episodes.delete(id); this.failureDirty = true;
      }
    }
  }
  private async persistFailures(): Promise<void> {
    if (!this.failureDirty) return;
    // Capture can run while the async write prepares: only clear dirtiness for the same snapshot.
    const snapshot = JSON.stringify(this.failures);
    if (Buffer.byteLength(snapshot) > 2 * 1024 * 1024) throw new Error('Webhook failure identity capacity exhausted');
    await atomicWrite(this.directory, 'failure-episodes.json', this.failures);
    this.failureDirty = JSON.stringify(this.failures) !== snapshot;
  }
  private stateFor(source: WebhookSource, frozen?: FailureDisposition) {
    if (this.store) {
      const run = this.store.getRun(source.snapshot.id);
      return freshness(source, { current: run ? runLifecycleSnapshot(run) : undefined, now: this.now(), active: this.manager?.isActive(source.snapshot.id) ?? true,
        resumeScheduled: this.manager?.hasScheduledAutoResume?.(source.snapshot.id) === true,
        context: this.ready ? 'ready' : 'recovering', currentEpisodeId: this.episodes.get(source.snapshot.id) ?? '', ...(frozen ? { frozen } : {}) });
    }
    const disk = readRunIndexDiagnostic(this.options.dataDir, this.options.root);
    const run = disk.runs.find(candidate => candidate.id === source.snapshot.id);
    return freshness(source, { current: run ? runLifecycleSnapshot(run) : undefined, now: this.now(), active: false,
      context: disk.state === 'complete' ? 'unopened' : 'recovering', ...(frozen ? { frozen } : {}) });
  }
  private async status(admission: Admission, id: string, status: DeliveryRecord['status'], reason: string): Promise<void> {
    await this.admissions.update(admission.id, record => {
      const delivery = record.deliveries.find(item => item.id === id)!;
      delivery.status = status; delivery.reason = reason; delivery.claim = undefined;
      if (terminalDelivery(status)) delivery.completedAt = new Date(this.now()).toISOString();
    });
    await this.recordHistory(admission.id, id);
    await this.endpoints.invalidate();
  }
  private async maintain(): Promise<void> {
    if (this.nextMaintenance > this.now()) return;
    this.nextMaintenance = this.now() + 30000;
    this.retireEndedFailures();
    await this.persistFailures();
    if (!await this.outbox.compact()) return;
    this.identity.highWater = this.outbox.highWater;
    await atomicWrite(this.directory, 'identity.json', this.identity);
    await this.admissions.prune(this.outbox.compactedThrough);
    await this.history.prune();
    const retained = this.history.receiverIds();
    for (const record of this.admissions.all()) for (const delivery of record.deliveries) retained.add(delivery.receiverId);
    await this.endpoints.pruneHistory(retained);
  }
  private async choose(): Promise<Candidate | undefined> {
    await this.persistFailures();
    for (let count = 0; count < 100; count++) {
      const entry = this.outbox.peek(); if (!entry) break;
      const tracker = entry.source.snapshot.automationTracker;
      const trackerIssueUrl = tracker ? canonicalTrackerLink(tracker, await readTrackerAssociation(this.options.dataDir)) : undefined;
      const admitted = await this.admissions.admit({ ...entry.source, ...(trackerIssueUrl ? { trackerIssueUrl } : {}) }, this.endpoints.live()); if (!admitted) break;
      await this.persistFailures(); await this.outbox.advance(entry.end);
      for (const delivery of admitted.deliveries) if (terminalDelivery(delivery.status)) await this.recordHistory(admitted.id, delivery.id);
      await this.endpoints.invalidate();
    }
    await this.maintain();
    for (const admission of this.admissions.all()) for (const delivery of admission.deliveries) {
      if (terminalDelivery(delivery.status)) continue;
      if (Date.parse(delivery.expiresAt) <= this.now()) { await this.status(admission, delivery.id, 'failed', 'expired'); continue; }
      const receiver = this.endpoints.privateReceiver(delivery.receiverId);
      if (!receiver || receiver.deliveryRevision !== delivery.deliveryRevision || (delivery.eventType !== 'webhook.test' && ['inactive', 'paused', 'disabled'].includes(receiver.state))) {
        await this.status(admission, delivery.id, 'cancelled', 'receiver_changed'); continue;
      }
      if (delivery.claim && Date.parse(delivery.claim.until) > this.now()) continue;
      if (admission.source) {
        const current = this.stateFor(admission.source, delivery.frozen);
        if (current.kind === 'superseded') { await this.status(admission, delivery.id, 'superseded', current.reason); continue; }
        if (current.kind === 'defer') continue;
      }
      if (Date.parse(delivery.notBefore) > this.now() || (delivery.nextAttemptAt && Date.parse(delivery.nextAttemptAt) > this.now())) continue;
      if (receiver.state === 'suspended' && delivery.eventType !== 'webhook.test' && receiver.nextProbeAt && Date.parse(receiver.nextProbeAt) > this.now()) continue;
      if (!this.inFlight) return { admissionId: admission.id, deliveryId: delivery.id };
    }
    return undefined;
  }
  private async claim(candidate: Candidate): Promise<Claim | undefined> {
    const admission = this.admissions.get(candidate.admissionId); const delivery = admission?.deliveries.find(item => item.id === candidate.deliveryId);
    if (!admission || !delivery || terminalDelivery(delivery.status)) return;
    if (Date.parse(delivery.expiresAt) <= this.now()) { await this.status(admission, delivery.id, 'failed', 'expired'); return; }
    if ((admission.operations ?? []).some(operation => !operation.applied)) return;
    const receiver = this.endpoints.privateReceiver(delivery.receiverId);
    if (!receiver || receiver.deliveryRevision !== delivery.deliveryRevision || (delivery.eventType !== 'webhook.test' && !['active', 'suspended'].includes(receiver.state))) return;
    let disposition: FailureDisposition | undefined;
    if (admission.source) {
      const current = this.stateFor(admission.source, delivery.frozen);
      if (current.kind === 'defer') return;
      if (current.kind === 'superseded') { await this.status(admission, delivery.id, 'superseded', current.reason); return; }
      if (admission.source.type === 'task.failed') {
        disposition = current.disposition === 'scheduled' && 'autoResumeAt' in current && current.autoResumeAt
          ? { disposition: 'scheduled', autoResumeAt: current.autoResumeAt } : { disposition: 'manual' };
        if (disposition.disposition === 'scheduled' && receiver.preset !== 'all' && !receiver.includeScheduledFailures) { await this.status(admission, delivery.id, 'superseded', 'auto_resume_scheduled'); return; }
        const episode = this.failures.episodes[admission.source.snapshot.id];
        if (!episode || episode.episodeId !== admission.source.episodeId) { await this.status(admission, delivery.id, 'superseded', 'episode_changed'); return; }
        const decisions = episode.decisions[receiver.id] ?? {};
        const existing = decisions[disposition.disposition];
        if (existing && existing !== delivery.id && !admission.operations?.some(operation => operation.action === 'replay' && operation.deliveryId === delivery.id)) { await this.status(admission, delivery.id, 'superseded', 'duplicate_failure_disposition'); return; }
        episode.decisions[receiver.id] = { ...decisions, [disposition.disposition]: delivery.id }; this.failureDirty = true; await this.persistFailures();
      }
    }
    const limit = await this.limits.take({ host: new URL(receiver.url).hostname, test: delivery.eventType === 'webhook.test', manualFailure: disposition?.disposition === 'manual' }, this.now());
    if (!limit.allowed) {
      await this.admissions.update(admission.id, record => { const item = record.deliveries.find(item => item.id === delivery.id)!; item.nextAttemptAt = new Date(limit.retryAt).toISOString(); item.reason = 'rate_limited'; }); return;
    }
    const body = delivery.body ?? (admission.source ? renderPayload(admission.source, delivery.profile, this.endpoints.signingKeys(receiver.id), disposition, this.options.repository) : undefined);
    if (!body) { await this.status(admission, delivery.id, 'failed', 'payload_invalid'); return; }
    const token = randomUUID();
    await this.admissions.update(admission.id, record => {
      const item = record.deliveries.find(item => item.id === delivery.id)!;
      item.body = body; item.frozen = disposition; item.status = 'in_flight'; item.attempts++;
      item.claim = { token, revision: receiver.revision, until: new Date(this.now() + 10000).toISOString() };
    });
    return { ...candidate, token, revision: receiver.revision, request: { url: receiver.url, body, eventId: admission.id, secrets: this.endpoints.signingKeys(receiver.id),
      policy: { mode: admission.source?.mode === 'hosted' || receiver.activation?.mode === 'hosted' ? 'hosted' : this.options.mode, allowLocalNetwork: receiver.allowLocalNetwork, serverPorts: this.options.serverPorts() }, signal: this.abort.signal } };
  }
  private async complete(claim: Claim, result: SendResult): Promise<void> {
    const admission = this.admissions.get(claim.admissionId); const delivery = admission?.deliveries.find(item => item.id === claim.deliveryId);
    if (!admission || !delivery || delivery.claim?.token !== claim.token) return;
    const success = result.kind === 'http' && result.status >= 200 && result.status < 300;
    const outcome = success ? 'success' : result.kind === 'policy' ? 'policy' : result.kind === 'http' && result.status === 410 ? 'gone'
      : result.kind === 'http' && result.status === 429 ? 'rate_limited' : result.kind === 'transient' || (result.kind === 'http' && (result.status === 408 || result.status >= 500)) ? 'transient' : 'permanent';
    await this.admissions.update(admission.id, record => {
      const item = record.deliveries.find(item => item.id === delivery.id)!; item.claim = undefined;
      if (result.kind === 'http') { item.httpStatus = result.status; item.response = result.response; }
      if (success) { item.status = 'delivered'; item.completedAt = new Date(this.now()).toISOString(); item.reason = this.options.dryRun ? 'dry-run' : undefined; }
      else if (outcome === 'transient' || outcome === 'rate_limited' || outcome === 'policy') {
        item.status = outcome === 'policy' ? 'blocked_policy' : 'retrying';
        item.nextAttemptAt = new Date(outcome === 'policy' ? this.now() + 900000 : retryAt(item.attempts, this.now(), result.kind === 'http' ? result.retryAfter : undefined)).toISOString();
        item.reason = result.kind === 'http' ? `http_${result.status}` : result.reason;
      } else { item.status = 'failed'; item.completedAt = new Date(this.now()).toISOString(); item.reason = result.kind === 'http' ? `http_${result.status}` : 'delivery_failed'; }
    });
    await this.recordHistory(admission.id, delivery.id);
    await this.endpoints.deliveryResult(delivery.receiverId, claim.revision, delivery.deliveryRevision, outcome, delivery.eventType === 'webhook.test');
    this.emit('change', this.endpoints.list().changeSequence);
  }
  async tick(): Promise<void> {
    const candidate = await this.serialize(async () => { const value = await this.choose(); if (value) this.inFlight = true; return value; });
    if (!candidate) return;
    const work = (async () => {
      let release: (() => void) | undefined;
      try {
        const record = this.admissions.get(candidate.admissionId)!.deliveries.find(item => item.id === candidate.deliveryId)!;
        const receiver = this.endpoints.privateReceiver(record.receiverId); if (!receiver) return;
        release = await this.options.scheduler.acquire(this.options.dataDir, new URL(receiver.url).hostname, this.abort.signal); if (!release) return;
        const claim = await this.serialize(() => this.claim(candidate)); if (!claim) return;
        const controller = new AbortController(); this.currentAttempt = { receiverId: record.receiverId, controller };
        claim.request.signal = AbortSignal.any([this.abort.signal, controller.signal]);
        const result = this.options.dryRun ? { kind: 'http' as const, status: 204 } : await this.send(claim.request).catch(() => ({ kind: 'transient' as const, reason: 'transport_failed' }));
        await this.serialize(() => this.complete(claim, result));
      } finally { this.currentAttempt = undefined; release?.(); this.inFlight = false; }
    })();
    this.attempts.add(work); try { await work; } finally { this.attempts.delete(work); }
  }
  create(input: unknown) { return this.serialize(() => this.endpoints.create(input)); }
  activate(id: string, revision: number) { return this.serialize(() => this.endpoints.activate(id, revision)); }
  resume(id: string, revision: number) { return this.serialize(() => this.endpoints.resume(id, revision)); }
  pause(id: string, revision: number) { return this.serialize(async () => { const receiver = await this.endpoints.pause(id, revision); await this.cancelUnsent(id); return receiver; }); }
  update(id: string, input: UpdateWebhook) { return this.serialize(async () => { const before = this.endpoints.privateReceiver(id); const receiver = await this.endpoints.update(id, input); if (before?.deliveryRevision !== receiver.deliveryRevision) await this.cancelUnsent(id); return receiver; }); }
  delete(id: string, revision: number) { return this.serialize(async () => { await this.endpoints.delete(id, revision); await this.cancelUnsent(id); for (const episode of Object.values(this.failures.episodes)) delete episode.decisions[id]; this.failureDirty = true; await this.persistFailures(); }); }
  rotate(id: string, revision: number, mode: 'graceful' | 'revoke_now') { return this.serialize(() => this.endpoints.rotate(id, revision, mode)); }
  acknowledge(sequence: number) { return this.serialize(() => this.endpoints.acknowledge(sequence)); }
  test(id: string, input: WebhookOperation) { return this.serialize(() => this.operations.test(id, input)); }
  retry(id: string, input: WebhookOperation) { return this.serialize(() => this.operations.delivery('retry', id, input)); }
  replay(id: string, input: WebhookOperation) { return this.serialize(() => this.operations.delivery('replay', id, input)); }
  private async cancelUnsent(id: string): Promise<void> {
    if (this.currentAttempt?.receiverId === id) this.currentAttempt.controller.abort();
    for (const record of this.admissions.all()) for (const delivery of record.deliveries) {
      if (delivery.receiverId === id && !terminalDelivery(delivery.status) && delivery.status !== 'in_flight') await this.status(record, delivery.id, 'cancelled', 'receiver_changed');
    }
  }
  private async flushActions(): Promise<void> {
    const system = new Set(['delivery_result', 'test_result', 'delivery_changed', 'history_pruned']);
    while (this.adminActions.length) {
      const next = this.adminActions[0]!;
      // Individual transport results are in delivery history, not repeated in the admin log.
      if (!['delivery_result', 'delivery_changed'].includes(next.action)) await this.history.activity(next.receiverId, {
        id: randomUUID(), at: new Date(this.now()).toISOString(), action: next.action,
        source: system.has(next.action) ? 'system' : 'cockpit/api', fields: [], ...(next.revision > 0 ? { revision: next.revision } : {}),
      }, this.endpoints.live().flatMap(receiver => [receiver.url, ...this.endpoints.signingKeys(receiver.id)]));
      this.adminActions.shift();
    }
  }
  private display(record: Admission, item: DeliveryRecord): WebhookDelivery {
    const receiver = this.endpoints.privateReceiver(item.receiverId);
    const active = receiver?.state === 'active' && receiver.deliveryRevision === item.deliveryRevision;
    const fresh = !record.source || this.stateFor(record.source, item.frozen).kind === 'ready';
    return { deliveryId: item.id, eventId: record.id, receiverId: item.receiverId, deliveryRevision: item.deliveryRevision,
      eventType: item.eventType, ...(record.source ? { taskId: record.source.snapshot.id } : {}), status: item.status,
      createdAt: item.createdAt, expiresAt: item.expiresAt, attempts: item.attempts, destination: item.destination,
      ...(item.nextAttemptAt ? { nextAttemptAt: item.nextAttemptAt } : {}), ...(item.completedAt ? { completedAt: item.completedAt } : {}),
      ...(item.httpStatus !== undefined ? { httpStatus: item.httpStatus } : {}), ...(item.reason ? { reason: item.reason } : {}), ...(item.response ? { response: item.response } : {}),
      retryAllowed: !!active && fresh && ['pending', 'retrying'].includes(item.status) && Date.parse(item.expiresAt) > this.now() && Date.parse(item.notBefore) <= this.now() && (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= this.now()),
      replayAllowed: !!active && fresh && ['delivered', 'failed'].includes(item.status) && item.eventType !== 'webhook.test' && !!item.body && !!item.completedAt && Date.parse(item.completedAt) + 7 * 86400000 > this.now(),
    };
  }
  private async recordHistory(eventId: string, deliveryId: string): Promise<void> {
    const record = this.admissions.get(eventId)!;
    await this.history.result(this.display(record, record.deliveries.find(item => item.id === deliveryId)!));
  }
  private receiverIdentity(id: string) {
    const receiver = this.list().receivers.find(receiver => receiver.id === id) ?? this.endpoints.historical().find(receiver => receiver.id === id);
    if (!receiver) throw new WebhookStateError(404, 'Receiver not found'); return receiver;
  }
  historyPage(query: { limit: number; cursor?: string }): WebhookHistoryPage {
    const page = pageRecords(this.endpoints.historical().map(receiver => ({ ...receiver, at: receiver.deletedAt })), JSON.stringify([this.options.projectId, 'history']), query);
    return { ...page, items: page.items.map(({ at: _, ...item }) => item) };
  }
  deliveryPage(id: string, query: { limit: number; cursor?: string; taskId?: string }): WebhookDeliveriesPage {
    const receiver = this.receiverIdentity(id);
    const rows = new Map(this.history.results(id).map(row => [row.deliveryId, { ...row, retryAllowed: false, replayAllowed: false }]));
    for (const record of this.admissions.all()) for (const item of record.deliveries) if (item.receiverId === id) rows.set(item.id, this.display(record, item));
    const page = pageRecords([...rows.values()].filter(row => !query.taskId || row.taskId === query.taskId).map(row => ({ ...row, id: row.deliveryId, at: row.createdAt })), JSON.stringify([this.options.projectId, id, query.taskId ?? '']), query);
    return { ...page, receiver, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, items: page.items.map(({ id: _, at: __, ...row }) => row) };
  }
  activityPage(id: string): WebhookActivityPage {
    const receiver = this.receiverIdentity(id), rows = this.history.activities(id).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
    return { receiver, items: rows.slice(0, 100), total: rows.length, hasMore: rows.length > 100, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  list() {
    const result = this.endpoints.list();
    for (const receiver of result.receivers) { const items = this.deliveries(receiver.id); receiver.pendingCount = items.filter(item => !terminalDelivery(item.status)).length; receiver.inFlightCount = items.filter(item => item.status === 'in_flight').length; }
    if (this.broken || !this.ownership.valid()) result.webhookHealth = { status: 'unavailable', reason: 'Webhook service is unavailable' };
    else if (this.identity.resetReason && !result.receivers.length) result.webhookHealth = { status: 'degraded', reason: 'Untrusted copied webhook state was reset. Configure receivers for this project.' };
    else if (this.outbox.captureGap || this.captureFailed) result.webhookHealth = { status: 'degraded', reason: 'Some task changes could not be captured' };
    return result;
  }
  deliveries(receiverId: string): DeliveryRecord[] { return this.admissions.all().flatMap(record => record.deliveries).filter(delivery => delivery.receiverId === receiverId); }
  async dispose(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) clearInterval(this.timer); this.store?.setLifecycleObserver(undefined); this.abort.abort();
    await Promise.allSettled([...this.attempts]); await this.tail;
    this.stopped = true;
    await this.ownership.release(); this.emit('dispose'); this.removeAllListeners();
  }
}
