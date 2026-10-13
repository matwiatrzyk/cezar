import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { webhookDeliveryStatusSchema, webhookEventTypeSchema, webhookProfileSchema, type WebhookHealth } from '@open-mercato/cezar-contract';
import { webhookSourceSchema, type WebhookSource } from './source.ts';
import { WebhookStateError, type PrivateReceiver } from './endpoints.ts';
import { selected } from './lifecycle.ts';
import { renderPayload } from './payload.ts';
import { maskDestination } from './destination.ts';
import { assertNoSymlink, atomicWrite, readState, statePath } from './storage.ts';

const time = z.iso.datetime();
export const deliveryRecordSchema = z.strictObject({
  id: z.string().uuid(), receiverId: z.string().uuid(), deliveryRevision: z.number().int().positive(), admittedRevision: z.number().int().positive(),
  profile: webhookProfileSchema, eventType: webhookEventTypeSchema, destination: z.string().max(300),
  createdAt: time, notBefore: time, expiresAt: time, status: webhookDeliveryStatusSchema, attempts: z.number().int().nonnegative(),
  body: z.string().max(65536).optional(), completedAt: time.optional(), reason: z.string().max(500).optional(), nextAttemptAt: time.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(), response: z.string().max(4096).optional(),
  claim: z.strictObject({ token: z.string().uuid(), revision: z.number().int().positive(), until: time }).optional(),
  frozen: z.discriminatedUnion('disposition', [z.strictObject({ disposition: z.literal('manual') }), z.strictObject({ disposition: z.literal('scheduled'), autoResumeAt: time })]).optional(),
  historyPending: z.boolean().optional(),
  resultEffects: z.strictObject({ token: z.string().uuid(), revision: z.number().int().positive(), at: time,
    outcome: z.enum(['success', 'transient', 'permanent', 'gone', 'rate_limited', 'policy']),
  }).optional(),
  operationId: z.string().max(128).optional(),
});
export const operationReceiptSchema = z.strictObject({ operationId: z.string().max(128), fingerprint: z.string().max(1024), receiverId: z.string().uuid(), expectedRevision: z.number().int().positive(), deliveryId: z.string().uuid(), action: z.enum(['test', 'retry', 'replay']), applied: z.boolean() });
export type OperationReceipt = z.infer<typeof operationReceiptSchema>;
export const admissionSchema = z.strictObject({
  version: z.literal(1), id: z.string().regex(/^evt_[0-9a-f-]{36}$/), createdAt: time,
  source: webhookSourceSchema.optional(), sourceSequence: z.number().int().positive().optional(), deliveries: z.array(deliveryRecordSchema), control: z.boolean(),
  taskId: z.string().max(128).optional(),
  capacityNeed: z.strictObject({ retainedBytes: z.number().nonnegative(), retainedObjects: z.number().nonnegative(), pendingBytes: z.number().nonnegative(), pendingCount: z.number().nonnegative() }).optional(),
  decision: z.enum(['empty', 'expired', 'capacity', 'pending_capacity', 'retained_capacity']).optional(), operations: z.array(operationReceiptSchema).optional(),
});
export type DeliveryRecord = z.infer<typeof deliveryRecordSchema>;
export type Admission = z.infer<typeof admissionSchema>;
export const terminalDelivery = (status: DeliveryRecord['status']): boolean => ['delivered', 'failed', 'superseded', 'cancelled', 'dropped'].includes(status);
export interface AdmissionLimits { retainedBytes: number; retainedObjects: number; controlBytes: number; controlObjects: number; pendingBytes: number; pendingCount: number }
const defaults: AdmissionLimits = { retainedBytes: 128 * 1024 * 1024, retainedObjects: 50000, controlBytes: 4 * 1024 * 1024, controlObjects: 5000, pendingBytes: 50 * 1024 * 1024, pendingCount: 10000 };
interface Dependencies { now(): number; limits?: Partial<AdmissionLimits>; repository?: string; secrets?: () => readonly string[]; assertOwner?: () => void }
export class AdmissionRepository {
  private records = new Map<string, Admission>();
  private usage: AdmissionLimits = { retainedBytes: 0, retainedObjects: 0, controlBytes: 0, controlObjects: 0, pendingBytes: 0, pendingCount: 0 };
  private account(record: Admission): AdmissionLimits {
    let bytes = Buffer.byteLength(JSON.stringify(record)) + 1, pendingBytes = 0, pendingCount = 0;
    if (!record.control) for (const delivery of record.deliveries) {
      // Reserved metadata covers claims, failure diagnostics and terminal state even at saturation.
      bytes += Math.max(0, 8192 - Buffer.byteLength(JSON.stringify({ ...delivery, body: undefined })));
      if (!delivery.body && delivery.eventType === 'task.failed') bytes += 131074;
    }
    for (const delivery of record.deliveries) if (!terminalDelivery(delivery.status)) {
      pendingCount++; pendingBytes += delivery.body ? Buffer.byteLength(delivery.body) : 65536;
    }
    const objects = 1 + record.deliveries.length + (record.operations?.length ?? 0);
    return { retainedBytes: record.control ? 0 : bytes, retainedObjects: record.control ? 0 : objects,
      controlBytes: record.control ? bytes : 0, controlObjects: record.control ? objects : 0, pendingBytes, pendingCount };
  }
  private charge(record: Admission, sign: 1 | -1): void {
    const cost = this.account(record);
    for (const key of Object.keys(cost) as (keyof AdmissionLimits)[]) this.usage[key] += sign * cost[key];
  }
  private readonly limits: AdmissionLimits;
  private constructor(private readonly directory: string, private readonly deps: Dependencies) { this.limits = { ...defaults, ...deps.limits }; }
  static async open(root: string, deps: Dependencies): Promise<AdmissionRepository> {
    const directory = join(root, 'events'); assertNoSymlink(directory); await mkdir(directory, { recursive: true, mode: 0o700 });
    const repository = new AdmissionRepository(directory, deps);
    const names = await readdir(directory);
    if (names.length > repository.limits.retainedObjects + repository.limits.controlObjects) throw new Error('Webhook admissions exceed object limit');
    for (const name of names) {
      if (!/^evt_[0-9a-f-]{36}\.json$/.test(name)) { if (!name.endsWith('.tmp')) throw new Error('Unknown webhook admission file'); continue; }
      const admission = await readState(directory, name, admissionSchema);
      if (!admission || name !== `${admission.id}.json`) throw new Error('Invalid webhook admission identity');
      repository.records.set(admission.id, admission); repository.charge(admission, 1);
    }
    if ((Object.keys(repository.usage) as (keyof AdmissionLimits)[]).some(key => repository.usage[key] > repository.limits[key])) throw new Error('Webhook retained capacity exceeded');
    return repository;
  }
  /** Bounded by the repository's load limits; only dirty metadata is republished. */
  async clearLegacyResponses(): Promise<void> {
    for (const record of this.records.values()) {
      if (!record.deliveries.some(delivery => delivery.response !== undefined)) continue;
      await this.update(record.id, next => { for (const delivery of next.deliveries) delete delivery.response; });
    }
  }
  get(id: string): Admission | undefined { const value = this.records.get(id); return value ? structuredClone(value) : undefined; }
  all(): Admission[] { return structuredClone([...this.records.values()]); }
  saturation(): NonNullable<WebhookHealth['saturation']> {
    let pending = false, retained = false, dropped = 0;
    for (const record of this.records.values()) {
      dropped += record.deliveries.filter(delivery => delivery.status === 'dropped').length;
      const need = record.capacityNeed; if (!need) continue;
      pending ||= this.usage.pendingBytes + need.pendingBytes > this.limits.pendingBytes || this.usage.pendingCount + need.pendingCount > this.limits.pendingCount;
      retained ||= this.usage.retainedBytes + need.retainedBytes > this.limits.retainedBytes || this.usage.retainedObjects + need.retainedObjects > this.limits.retainedObjects;
    }
    return { pending, retained, control: this.controlBlocked, dropped };
  }
  private controlBlocked = false;
  private fits(candidate: Admission): boolean {
    if (Buffer.byteLength(JSON.stringify(candidate)) > 8 * 1024 * 1024) return false;
    const cost = this.account(candidate), old = this.records.get(candidate.id), previous = old ? this.account(old) : undefined;
    return (Object.keys(cost) as (keyof AdmissionLimits)[]).every(key => this.usage[key] - (previous?.[key] ?? 0) + cost[key] <= this.limits[key]);
  }

  /** One owner mutation queue must serialize admission, claims, updates and retention. */
  async admit(source: WebhookSource, receivers: readonly PrivateReceiver[]): Promise<Admission | undefined> {
    const existing = this.records.get(source.id); if (existing) return structuredClone(existing);
    const now = this.deps.now(), expires = Date.parse(source.occurredAt) + 72 * 3600000;
    const targets = expires <= now ? [] : receivers.filter(receiver =>
      ['active', 'suspended'].includes(receiver.state) && receiver.activation?.installationId === source.installationId &&
      source.sequence > receiver.activation.sequence && selected(receiver, source.type, source.snapshot));
    const deliveries: DeliveryRecord[] = targets.map(receiver => ({
      id: randomUUID(), receiverId: receiver.id, deliveryRevision: receiver.deliveryRevision, admittedRevision: receiver.revision,
      profile: receiver.profile, eventType: source.type, destination: maskDestination(receiver.url), createdAt: new Date(now).toISOString(),
      notBefore: new Date(Date.parse(source.occurredAt) + (source.type === 'task.failed' ? 30 : ['task.attention_required', 'task.review_ready'].includes(source.type) ? receiver.graceSeconds : 0) * 1000).toISOString(),
      expiresAt: new Date(expires).toISOString(), status: 'pending', attempts: 0,
      ...(source.type === 'task.failed' ? {} : { body: renderPayload(source, receiver.profile, this.deps.secrets?.() ?? [], undefined, this.deps.repository) }),
    }));
    let admission: Admission = { version: 1, id: source.id, createdAt: new Date(now).toISOString(), source, sourceSequence: source.sequence, deliveries, control: !deliveries.length,
      ...(!deliveries.length ? { decision: expires <= now ? 'expired' as const : 'empty' as const } : {}) };
    if (!deliveries.length) admission.source = undefined;
    if (!this.fits(admission)) {
      const cost = this.account(admission);
      const reason = this.usage.retainedBytes + cost.retainedBytes > this.limits.retainedBytes || this.usage.retainedObjects + cost.retainedObjects > this.limits.retainedObjects ? 'retained_capacity' as const : 'pending_capacity' as const;
      const capacityNeed = { retainedBytes: cost.retainedBytes, retainedObjects: cost.retainedObjects, pendingBytes: cost.pendingBytes, pendingCount: cost.pendingCount };
      admission = { ...admission, control: true, source: undefined, taskId: source.snapshot.id, capacityNeed, decision: reason, deliveries: deliveries.map(delivery => ({
        ...delivery, body: undefined, historyPending: true, status: 'dropped', completedAt: new Date(now).toISOString(), reason,
      })) };
      if (!this.fits(admission)) { this.controlBlocked = true; return undefined; } // Preserve source and cursor; control space is exhausted.
    }
    this.controlBlocked = false;
    await this.save(admission);
    return structuredClone(admission);
  }
  async update(id: string, mutate: (record: Admission) => void): Promise<Admission> {
    const old = this.records.get(id); if (!old) throw new Error('Webhook admission not found');
    const next = structuredClone(old); mutate(next);
    for (const previous of old.deliveries) {
      const updated = next.deliveries.find(delivery => delivery.id === previous.id);
      if (previous.body && updated?.body !== previous.body) throw new Error('Frozen webhook bytes cannot change');
    }
    if (!this.fits(next)) throw new WebhookStateError(503, 'Webhook retained capacity exhausted; wait for retention to release space');
    await this.save(next); return structuredClone(next);
  }
  async insert(value: Admission): Promise<Admission> {
    if (this.records.has(value.id)) throw new Error('Duplicate admission');
    if (!this.fits(value)) throw new WebhookStateError(503, 'Webhook retained capacity exhausted; wait for retention to release space');
    await this.save(value); return structuredClone(value);
  }
  private async save(value: Admission): Promise<void> {
    this.deps.assertOwner?.(); const next = admissionSchema.parse(value);
    await atomicWrite(this.directory, `${next.id}.json`, next);
    const previous = this.records.get(next.id); if (previous) this.charge(previous, -1);
    this.records.set(next.id, next); this.charge(next, 1);
  }
  /** Only after durable source compaction and seven days after the last terminal cycle. */
  async prune(compactedThrough: number): Promise<void> {
    for (const record of this.records.values()) {
      if (record.sourceSequence !== undefined && record.sourceSequence > compactedThrough) continue;
      if (record.deliveries.some(delivery => !terminalDelivery(delivery.status) || delivery.historyPending || delivery.resultEffects || !delivery.completedAt || Date.parse(delivery.completedAt) + 7 * 86400000 > this.deps.now())) continue;
      if (!record.deliveries.length && Date.parse(record.createdAt) + 7 * 86400000 > this.deps.now()) continue;
      this.deps.assertOwner?.(); await rm(statePath(this.directory, `${record.id}.json`)); this.records.delete(record.id); this.charge(record, -1);
    }
  }
}
