import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WebhookService } from './service.ts';
import { WebhookScheduler } from './scheduler.ts';
import { AdmissionRepository } from './admission.ts';
import { Outbox } from './outbox.ts';
const day = 86400000;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  vi.stubEnv('CEZ_WEBHOOKS', '1');
  const root = mkdtempSync(join(tmpdir(), 'webhook-retention-health-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar'), start = Date.parse('2026-10-13T12:00:00Z'); let now = start;
  const send = vi.fn(async () => ({ kind: 'http' as const, status: 204 }));
  const options = { root, dataDir, projectId: 'fixture', mode: 'local' as const, serverPorts: () => [], scheduler: new WebhookScheduler(), now: () => now, send };
  let service = (await WebhookService.open(options))!;
  const store = RunStore.open(dataDir); service.attach(store, { isActive: () => false }, true);
  cleanups.push(async () => { await service.dispose(); store.flush(); rmSync(root, { recursive: true, force: true }); });
  const { receiver } = await service.create({ name: 'Fixture', url: 'https://receiver.invalid/private?token=secret-fixture', graceSeconds: 0 });
  await service.activate(receiver.id, 1);
  return { get service() { return service; }, store, receiver, dataDir, send, at: (age: number) => { now = start + age; },
    finish() { const run = store.createRun({ title: 'private task', task: 'private task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); return run; },
    async reopen() { await service.dispose(); service = (await WebhookService.open(options))!; service.attach(store, { isActive: () => false }, true); },
  };
}
it('expires each replay cycle before filtering/pagination and retires its metadata without losing newer bytes or receipts', async () => {
  const x = await fixture(), run = x.finish(); await x.service.tick();
  const page = (cursor?: string) => x.service.deliveryPage(x.receiver.id, { limit: 2, taskId: run.id, ...(cursor ? { cursor } : {}) });
  const original = page().items[0]!; let latest = original.deliveryId;
  const bytes = x.service.deliveries(x.receiver.id)[0]!.body;
  let firstReplay: { target: string; input: { expectedRevision: number; deliveryRevision: number; operationId: string }; result: { deliveryId: string } } | undefined;
  for (let i = 1; i <= 6; i++) {
    if (i === 5) {
      x.at(30 * day - 1);
      expect(x.service.deliveryPage(x.receiver.id, { limit: 100 }).items.some(row => row.deliveryId === original.deliveryId)).toBe(true);
      const cursor = page().nextCursor!;
      x.at(30 * day);
      // No maintenance yet: both persisted history and admission fallback must obey the boundary.
      expect(x.service.deliveryPage(x.receiver.id, { limit: 100 }).items.some(row => row.deliveryId === original.deliveryId)).toBe(false);
      expect(page().total).toBe(4);
      expect(page(cursor).items.some(row => row.deliveryId === original.deliveryId)).toBe(false);
    }
    x.at(i * 6 * day);
    const receiver = x.service.list().receivers[0]!;
    const input = { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: `replay-${i}` };
    const result = await x.service.replay(latest, input);
    if (i === 1) firstReplay = { target: latest, input, result };
    latest = result.deliveryId; await x.service.tick();
  }
  x.at(37 * day); await x.service.tick();
  expect(page().total).toBe(5);
  expect(x.service.deliveryPage(x.receiver.id, { limit: 100, taskId: 'unrelated' }).items).toEqual([]);
  const persisted = JSON.parse(readFileSync(join(x.dataDir, 'webhooks/events', `${original.eventId}.json`), 'utf8'));
  expect(persisted.deliveries.some((row: { id: string }) => [original.deliveryId, firstReplay!.result.deliveryId].includes(row.id))).toBe(false);
  expect(persisted.deliveries.at(-1).body).toBe(bytes);
  expect(persisted.operations).toHaveLength(6);
  expect(persisted.sourceSequence).toBe(1);
  await x.reopen();
  expect(page().total).toBe(5);
  expect(page().items[0]).toMatchObject({ deliveryId: latest, eventId: original.eventId, replayAllowed: true });
  expect(await x.service.replay(firstReplay!.target, firstReplay!.input)).toEqual(firstReplay!.result);
  expect(x.send).toHaveBeenCalledTimes(7);
});
it('keeps source acknowledgement and unfinished result/operation obligations while retiring old cycles', async () => {
  const x = await fixture(); x.finish(); await x.service.tick();
  const repository = (x.service as unknown as { admissions: AdmissionRepository }).admissions;
  const record = repository.all()[0]!, delivery = record.deliveries[0]!;
  x.at(31 * day);
  await repository.prune(0); expect(repository.get(record.id)).toBeDefined();
  await repository.update(record.id, next => { next.deliveries[0]!.historyPending = true; });
  await repository.prune(1); expect(repository.get(record.id)?.deliveries).toHaveLength(1);
  await repository.update(record.id, next => { next.deliveries[0]!.historyPending = undefined; next.deliveries[0]!.resultEffects = { token: delivery.id, revision: 2, at: delivery.completedAt!, outcome: 'success' }; });
  await repository.prune(1); expect(repository.get(record.id)?.deliveries).toHaveLength(1);
  await repository.update(record.id, next => { next.deliveries[0]!.resultEffects = undefined; next.operations = [{ operationId: 'unapplied', fingerprint: 'fixture', receiverId: x.receiver.id, expectedRevision: 2, deliveryId: delivery.id, action: 'replay', applied: false }]; });
  await repository.prune(1); expect(repository.get(record.id)).toBeDefined();
  await repository.update(record.id, next => { next.operations![0]!.applied = true; });
  await repository.prune(1); expect(repository.get(record.id)).toBeUndefined();
});
it('invalidates capture-only loss with no admissions and warns once per failure episode outside the observer', async () => {
  const x = await fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), change = vi.fn();
  x.service.on('change', change);
  const outbox = (x.service as unknown as { outbox: Outbox }).outbox;
  const capacity = Reflect.get(outbox, 'capacity'); Reflect.set(outbox, 'capacity', 1);
  const run = x.finish(); x.finish();
  expect(warn).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  for (let i = 1; i <= 12; i++) { x.at(i * 5000); await x.service.tick(); }
  expect(x.store.getRun(run.id)?.status).toBe('done'); expect(x.send).not.toHaveBeenCalled();
  expect(x.service.deliveries(x.receiver.id)).toEqual([]);
  expect(x.service.list().webhookHealth).toMatchObject({ status: 'degraded', reason: 'Some task changes could not be captured' });
  expect(change).toHaveBeenCalledTimes(1); expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret-fixture|receiver\.invalid/);
  Reflect.set(outbox, 'capacity', capacity); x.finish(); await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
  // Recovery of capture does not erase the truthful past-loss diagnostic.
  expect(x.service.list().webhookHealth.status).toBe('degraded');
  Reflect.set(outbox, 'capacity', 1); x.finish(); await x.service.tick(); expect(warn).toHaveBeenCalledTimes(2);
  Reflect.set(outbox, 'capacity', capacity); await x.reopen(); x.finish(); await x.service.tick();
  expect(x.send).toHaveBeenCalledTimes(2); expect(x.service.list().webhookHealth.status).toBe('ready');
});

it('expires compact history at the same boundary even after the admission is gone and across reopen', async () => {
  const x = await fixture(); x.finish(); await x.service.tick();
  x.at(8 * day); await x.service.tick(); expect(x.service.deliveries(x.receiver.id)).toEqual([]);
  x.at(30 * day - 1); expect(x.service.deliveryPage(x.receiver.id, { limit: 100 }).total).toBe(1);
  x.at(30 * day); expect(x.service.deliveryPage(x.receiver.id, { limit: 100 }).total).toBe(0);
  await x.reopen(); expect(x.service.deliveryPage(x.receiver.id, { limit: 100 }).total).toBe(0);
});
it('publishes append failure health and a safe warning even when queued work is unavailable', async () => {
  const x = await fixture(), warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), change = vi.fn();
  const outbox = (x.service as unknown as { outbox: Outbox }).outbox;
  vi.spyOn(outbox, 'append').mockImplementation(() => { Reflect.set(outbox, 'unavailable', true); throw new Error('secret-fixture'); });
  x.service.on('change', change); x.finish();
  expect(warn).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
  for (let i = 0; i < 3; i++) await expect(x.service.tick()).rejects.toThrow('unavailable');
  expect(x.service.list().webhookHealth.status).toBe('unavailable');
  expect(warn).toHaveBeenCalledTimes(1); expect(change).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-fixture');
  expect(x.send).not.toHaveBeenCalled();
  await x.reopen(); x.finish(); await x.service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
});
