import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  createWebhookSchema, updateWebhookSchema, webhookReceiverStateSchema, webhookHistoricalReceiverSchema, webhookNoticeSchema,
  type WebhookReceiver, type WebhookList,
} from '@open-mercato/cezar-contract';
import { collectSecretValues, redactSecrets } from '../core/secret-redaction.ts';
import { generateSigningKey } from './signing.ts';
import { maskDestination } from './destination.ts';
import { prepareWrite, readState } from './storage.ts';

const timestamp = z.iso.datetime();
const counter = z.number().int().nonnegative();
export const privateReceiverSchema = createWebhookSchema.safeExtend({
  lastResult: z.string().uuid().optional(),
  // Oldest audit revision whose result is still authoritative; only renames preserve it.
  resultRevision: counter.min(1).optional(),
  lastOperation: z.string().max(128).optional(),
  id: z.string().uuid(), state: webhookReceiverStateSchema, revision: counter.min(1), deliveryRevision: counter.min(1),
  secret: z.string().max(128), retired: z.strictObject({ secret: z.string().max(128), expiresAt: timestamp }).optional(),
  activation: z.strictObject({ installationId: z.string(), sequence: counter, revision: counter.min(1).optional(), mode: z.enum(['local', 'hosted']).default('local') }).optional(),
  createdAt: timestamp, updatedAt: timestamp, consecutiveFailures: counter,
  nextProbeAt: timestamp.optional(), activationBlocked: z.boolean(),
  lastTest: z.enum(['none', 'success', 'transient_failure', 'permanent_failure']),
});
export type PrivateReceiver = z.infer<typeof privateReceiverSchema>;
const stateSchema = z.strictObject({
  version: z.literal(1), receivers: z.array(privateReceiverSchema), history: z.array(webhookHistoricalReceiverSchema),
  changeSequence: counter, notice: webhookNoticeSchema.optional(),
});
type State = z.infer<typeof stateSchema>;
export class WebhookStateError extends Error {
  constructor(readonly status: 404 | 409 | 429 | 503, message: string, readonly retryAt?: number) { super(message); }
}
export interface EndpointDependencies {
  installationId: string; mode?: 'local' | 'hosted'; highWater(): number; now(): number; assertOwner(): void;
  reserve?(bytes: number): void;
  changed?(action: string, receiverId: string, revision: number, fields: string[]): void;
}
export class EndpointRegistry {
  private tail: Promise<unknown> = Promise.resolve();
  private constructor(private readonly directory: string, private readonly deps: EndpointDependencies, private state: State) {}
  static async open(directory: string, deps: EndpointDependencies): Promise<EndpointRegistry> {
    const state = await readState(directory, 'endpoints.json', stateSchema) ?? { version: 1 as const, receivers: [], history: [], changeSequence: 0 };
    return new EndpointRegistry(directory, deps, state);
  }
  async resetIntegrity(): Promise<void> {
    const next = structuredClone(this.state);
    for (const receiver of next.receivers) {
      receiver.state = 'inactive'; receiver.activation = undefined; receiver.revision++; receiver.deliveryRevision++;
      receiver.nextProbeAt = undefined; receiver.consecutiveFailures = 0; receiver.updatedAt = this.time();
    }
    await this.commit(next, 'integrity_reset', '', 0);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work); this.tail = result.catch(() => undefined); return result;
  }
  private get(id: string, expectedRevision?: number): PrivateReceiver {
    const receiver = this.state.receivers.find(item => item.id === id);
    if (!receiver) throw new WebhookStateError(404, 'Receiver not found');
    if (expectedRevision !== undefined && receiver.revision !== expectedRevision) throw new WebhookStateError(409, 'Receiver revision changed; refresh and try again');
    return receiver;
  }
  private public(receiver: PrivateReceiver): WebhookReceiver {
    return {
      kind: 'live', id: receiver.id, name: receiver.name, destination: maskDestination(receiver.url), format: 'cezar.json.v1',
      state: receiver.state, revision: receiver.revision, deliveryRevision: receiver.deliveryRevision,
      profile: receiver.profile, preset: receiver.preset, events: [...receiver.events], includeScheduledFailures: receiver.includeScheduledFailures,
      scope: receiver.scope, graceSeconds: receiver.graceSeconds, allowLocalNetwork: receiver.allowLocalNetwork,
      createdAt: receiver.createdAt, updatedAt: receiver.updatedAt, pendingCount: 0, inFlightCount: 0, consecutiveFailures: receiver.consecutiveFailures,
      ...(receiver.nextProbeAt ? { nextProbeAt: receiver.nextProbeAt } : {}),
      ...(receiver.retired ? { retiredKeyExpiresAt: receiver.retired.expiresAt } : {}),
      activationBlocked: receiver.activationBlocked, lastTest: receiver.lastTest,
    };
  }
  private secrets(): string[] { return [...collectSecretValues(), ...this.state.receivers.flatMap(item => [item.url, item.secret, ...(item.retired ? [item.retired.secret] : [])])]; }
  private time(): string { return new Date(this.deps.now()).toISOString(); }
  private async commit(next: State, action: string, id: string, revision: number, fence?: number, openNotice: boolean | 'preserve' = true, fields: string[] = []): Promise<boolean> {
    this.deps.assertOwner();
    next.changeSequence++;
    const receiver = next.receivers.find(item => item.id === id) ?? this.state.receivers.find(item => item.id === id);
    if (openNotice === true) next.notice = { changeSequence: next.changeSequence, at: this.time(), action, source: action === 'integrity_reset' ? 'system' : 'cockpit/api', ...(receiver ? { receiverName: receiver.name, receiverId: receiver.id, destination: maskDestination(receiver.url) } : {}) };
    else if (openNotice === false) next.notice = undefined;
    for (const item of next.receivers) {
      const previous = this.state.receivers.find(old => old.id === item.id);
      if (!previous || previous.revision !== item.revision) {
        item.resultRevision = action === 'renamed' && previous
          ? previous.resultRevision ?? previous.revision : item.revision;
      }
    }
    const checked = stateSchema.parse(next);
    this.deps.reserve?.(Buffer.byteLength(JSON.stringify(checked)));
    const prepared = await prepareWrite(this.directory, 'endpoints.json', checked);
    try {
      this.deps.assertOwner();
      if (fence !== undefined && this.deps.highWater() !== fence) return false;
      prepared.publish(); this.state = checked;
      await prepared.finish();
      this.deps.changed?.(action, id, revision, fields);
      return true;
    } finally { await prepared.discard(); }
  }
  list(): WebhookList {
    return { receivers: this.state.receivers.map(item => this.public(item)), webhookHealth: { status: 'ready' }, changeSequence: this.state.changeSequence,
      ...(this.state.notice ? { notice: { ...this.state.notice } } : {}), history: structuredClone(this.state.history.slice(0, 100)), historyCount: this.state.history.length };
  }
  historical() { return structuredClone(this.state.history); }
  pruneHistory(retained: ReadonlySet<string>): Promise<void> {
    return this.serial(async () => {
      const next = structuredClone(this.state); next.history = next.history.filter(item => retained.has(item.id));
      if (next.history.length !== this.state.history.length) await this.commit(next, 'history_pruned', '', 0, undefined, 'preserve');
    });
  }
  invalidate(): Promise<void> {
    return this.serial(async () => { await this.commit(structuredClone(this.state), 'delivery_changed', '', 0, undefined, 'preserve'); });
  }
  privateReceiver(id: string): PrivateReceiver | undefined { const receiver = this.state.receivers.find(item => item.id === id); return receiver ? structuredClone(receiver) : undefined; }
  live(): PrivateReceiver[] { return structuredClone(this.state.receivers); }
  signingKeys(id: string): string[] {
    const receiver = this.get(id);
    return [receiver.secret, ...(receiver.retired && Date.parse(receiver.retired.expiresAt) > this.deps.now() ? [receiver.retired.secret] : [])];
  }
  hasCapturingReceivers(): boolean { return this.state.receivers.some(receiver => receiver.state === 'active' || receiver.state === 'suspended'); }
  acknowledge(expectedChangeSequence: number): Promise<void> {
    return this.serial(async () => {
      if (expectedChangeSequence !== this.state.changeSequence) throw new WebhookStateError(409, 'Receiver notice changed; refresh and try again');
      await this.commit(structuredClone(this.state), 'notice_acknowledged', '', 0, undefined, false);
    });
  }
  create(input: unknown): Promise<{ receiver: WebhookReceiver; secret: string }> {
    return this.serial(async () => {
      const settings = createWebhookSchema.parse(input); settings.name = redactSecrets(settings.name, [...this.secrets(), settings.url]);
      const receiver: PrivateReceiver = { ...settings, id: randomUUID(), secret: generateSigningKey(), state: 'inactive', revision: 1, deliveryRevision: 1,
        createdAt: this.time(), updatedAt: this.time(), consecutiveFailures: 0, activationBlocked: false, lastTest: 'none' };
      const next = structuredClone(this.state); next.receivers.push(receiver);
      await this.commit(next, 'created', receiver.id, receiver.revision);
      return { receiver: this.public(receiver), secret: receiver.secret };
    });
  }
  update(id: string, input: unknown): Promise<WebhookReceiver> {
    return this.serial(async () => {
      const parsed = updateWebhookSchema.parse(input); const old = this.get(id, parsed.expectedRevision);
      const { expectedRevision: _, ...submitted } = parsed;
      const settings = { ...submitted, url: submitted.url ?? old.url };
      settings.name = redactSecrets(settings.name, [...this.secrets(), settings.url]);
      const fields = (['name', 'url', 'profile', 'preset', 'events', 'includeScheduledFailures', 'scope', 'graceSeconds', 'allowLocalNetwork'] as const).filter(key => JSON.stringify(settings[key]) !== JSON.stringify(old[key]));
      const changed = fields.some(key => key !== 'name');
      const receiver = { ...old, ...settings, revision: old.revision + 1, updatedAt: this.time() };
      if (changed) {
        receiver.state = 'inactive'; receiver.deliveryRevision++; receiver.activation = undefined;
        receiver.activationBlocked = false; receiver.lastTest = 'none'; receiver.consecutiveFailures = 0; receiver.nextProbeAt = undefined;
      }
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, changed ? 'configuration_changed' : 'renamed', id, receiver.revision, undefined, true, fields);
      return this.public(receiver);
    });
  }
  private activateAs(id: string, expectedRevision: number, resume: boolean): Promise<WebhookReceiver> {
    return this.serial(async () => {
      const old = this.get(id, expectedRevision);
      if (resume ? old.state !== 'paused' : !['inactive', 'disabled'].includes(old.state)) throw new WebhookStateError(409, 'Receiver state changed');
      if (old.activationBlocked || (old.state === 'disabled' && old.lastTest !== 'success')) throw new WebhookStateError(409, 'A successful test of this configuration is required');
      for (let attempt = 0; attempt < 3; attempt++) {
        const fence = this.deps.highWater();
        const receiver: PrivateReceiver = { ...old, state: 'active', revision: old.revision + 1, updatedAt: this.time(), consecutiveFailures: 0,
          activation: { installationId: this.deps.installationId, sequence: fence, revision: old.revision + 1, mode: this.deps.mode ?? 'local' }, nextProbeAt: undefined };
        const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
        if (await this.commit(next, resume ? 'resumed' : 'activated', id, receiver.revision, fence)) return this.public(receiver);
      }
      throw new WebhookStateError(503, 'Capture advanced while activating; try again');
    });
  }
  activate(id: string, expectedRevision: number) { return this.activateAs(id, expectedRevision, false); }
  resume(id: string, expectedRevision: number) { return this.activateAs(id, expectedRevision, true); }
  pause(id: string, expectedRevision: number): Promise<WebhookReceiver> {
    return this.serial(async () => {
      const old = this.get(id, expectedRevision);
      const receiver: PrivateReceiver = { ...old, state: 'paused', revision: old.revision + 1, updatedAt: this.time(), nextProbeAt: undefined };
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, 'paused', id, receiver.revision); return this.public(receiver);
    });
  }
  rotate(id: string, expectedRevision: number, mode: 'graceful' | 'revoke_now'): Promise<{ receiver: WebhookReceiver; secret: string }> {
    return this.serial(async () => {
      const old = this.get(id, expectedRevision);
      if (mode === 'graceful' && old.retired && Date.parse(old.retired.expiresAt) > this.deps.now()) throw new WebhookStateError(409, 'A key overlap is already active');
      const receiver: PrivateReceiver = { ...old, secret: generateSigningKey(), retired: mode === 'graceful' ? { secret: old.secret, expiresAt: new Date(this.deps.now() + 86400000).toISOString() } : undefined, revision: old.revision + 1, updatedAt: this.time() };
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, 'secret_rotated', id, receiver.revision); return { receiver: this.public(receiver), secret: receiver.secret };
    });
  }
  delete(id: string, expectedRevision: number): Promise<void> {
    return this.serial(async () => {
      const old = this.get(id, expectedRevision); const next = structuredClone(this.state);
      next.receivers = next.receivers.filter(item => item.id !== id);
      next.history.unshift({ kind: 'history', id, name: old.name, deletedAt: this.time() });
      await this.commit(next, 'deleted', id, old.revision + 1);
    });
  }
  recordOperation(id: string, expectedRevision: number, operationId: string, action: 'test' | 'retry' | 'replay'): Promise<void> {
    return this.serial(async () => {
      const old = this.get(id);
      if (old.lastOperation === operationId && old.revision === expectedRevision + 1) return;
      if (old.revision !== expectedRevision) throw new WebhookStateError(409, 'Receiver revision changed; refresh and try again');
      const receiver = { ...old, lastOperation: operationId, revision: old.revision + 1, updatedAt: this.time() };
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, action, id, receiver.revision);
    });
  }
  testResult(id: string, revision: number, deliveryRevision: number, result: 'success' | 'transient_failure' | 'permanent_failure'): Promise<void> {
    return this.deliveryResult(id, revision, deliveryRevision, result === 'success' ? 'success' : result === 'permanent_failure' ? 'permanent' : 'transient', true);
  }
  deliveryResult(id: string, revision: number, deliveryRevision: number, outcome: 'success' | 'transient' | 'permanent' | 'gone' | 'rate_limited' | 'policy', test: boolean, effect?: { token: string; at: string }): Promise<void> {
    return this.serial(async () => {
      const old = this.privateReceiver(id);
      if (!old || (effect && old.lastResult === effect.token) || (revision < (old.resultRevision ?? old.revision) || revision > old.revision) || old.deliveryRevision !== deliveryRevision) return;
      const receiver = { ...old, ...(effect ? { lastResult: effect.token } : {}) };
      if (test) {
        receiver.lastTest = outcome === 'success' ? 'success' : outcome === 'permanent' || outcome === 'gone' ? 'permanent_failure' : 'transient_failure';
        receiver.activationBlocked = outcome === 'success' ? false : old.activationBlocked || receiver.lastTest === 'permanent_failure';
      }
      if (outcome === 'success') {
        receiver.consecutiveFailures = 0;
        if (old.state === 'suspended') { receiver.state = 'active'; receiver.nextProbeAt = undefined; }
      } else if (outcome === 'gone' && ['active', 'suspended'].includes(old.state)) {
        receiver.state = 'disabled'; receiver.nextProbeAt = undefined;
      } else if (outcome === 'transient' && ['active', 'suspended'].includes(old.state)) {
        receiver.consecutiveFailures++;
        if (receiver.consecutiveFailures >= 10) { receiver.state = 'suspended'; receiver.nextProbeAt = new Date((effect ? Date.parse(effect.at) : this.deps.now()) + 900000).toISOString(); }
      }
      if (old.state === 'suspended' && receiver.state === 'suspended' && outcome !== 'success') receiver.nextProbeAt = new Date((effect ? Date.parse(effect.at) : this.deps.now()) + 900000).toISOString();
      if (receiver.state !== old.state) { receiver.revision++; receiver.updatedAt = this.time(); }
      const next = structuredClone(this.state); next.receivers = next.receivers.map(item => item.id === id ? receiver : item);
      await this.commit(next, test ? 'test_result' : 'delivery_result', id, receiver.revision, undefined, 'preserve');
    });
  }
}
