import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { WebhookScheduler } from './scheduler.ts';
import * as module from './service.ts';
import type { WebhookSend, SendResult } from './transport.ts';
const roots: string[] = [];
const services: module.WebhookService[] = [];
const stores: RunStore[] = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'webhook-service-')); roots.push(root); execFileSync('git', ['init', '-q'], { cwd: root });
  const dataDir = join(root, '.ai/cezar'); let now = Date.parse('2026-10-13T12:00:00Z');
  const send = vi.fn(async (_input: WebhookSend): Promise<SendResult> => ({ kind: 'http', status: 200 }));
  const options = { root, dataDir, projectId: 'project', mode: 'local' as const, serverPorts: () => [4317], scheduler: new WebhookScheduler(), now: () => now, send };
  return { root, dataDir, send, options, time: (value: number) => { now = value; } };
}
afterEach(async () => { for (const service of services.splice(0)) await service.dispose(); for (const store of stores.splice(0)) store.flush(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
describe('project webhook lifecycle service', () => {
  it('does not create storage or a service unless the exact flag is enabled', async () => {
    const x = await setup(); vi.stubEnv('CEZ_WEBHOOKS', 'true');
    expect(await module.WebhookService.open(x.options)).toBeUndefined();
    expect(existsSync(x.dataDir)).toBe(false);
  });
  it('captures only post-activation transitions and sends signed-body input outside task mutation', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const old = store.createRun({ title: 'earlier', task: 'private prompt', workflow: 'w', steps: [] }); store.updateRun(old.id, { status: 'done' });
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'now', task: 'private prompt', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done', completionReason: 'completed' });
    expect(x.send).not.toHaveBeenCalled();
    await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(x.send.mock.calls[0]![0].body)).toMatchObject({ type: 'task.finished', task: { id: run.id }, data: { resolution: 'completed' } });
    expect(x.send.mock.calls[0]![0].body).not.toContain('private prompt');
    expect(service.deliveries(receiver.receiver.id)[0]!.status).toBe('delivered');
  });
  it('suppresses replied questions during grace and defers failures while active', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); let active = false; service.attach(store, { isActive: () => active }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'waiting' }); store.updateRun(run.id, { status: 'running' });
    await service.tick(); expect(service.deliveries(receiver.receiver.id)[0]!.status).toBe('superseded');
    active = true; store.updateRun(run.id, { status: 'failed' }); x.time(Date.parse('2026-10-13T12:01:00Z'));
    await service.tick(); expect(x.send).not.toHaveBeenCalled();
    active = false; await service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
  });
  it('keeps failure disposition dedupe after restart and does not create a second manual alert', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'failed' }); x.time(Date.parse('2026-10-13T12:01:00Z'));
    await service.tick(); await service.dispose(); services.pop();
    service = (await module.WebhookService.open(x.options))!; services.push(service); service.attach(store, { isActive: () => false }, true);
    store.updateRun(run.id, { autoResumeAt: '2026-10-13T12:02:00Z' }); store.updateRun(run.id, { autoResumeAt: undefined });
    x.time(Date.parse('2026-10-13T12:01:31Z')); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
  });
  it('retains current failure identity beyond payload and history retention', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'failed' });
    x.time(Date.parse('2026-10-13T12:01:00Z')); await service.tick();
    x.time(Date.parse('2026-11-22T12:01:00Z')); await service.tick();
    expect(service.deliveries(receiver.receiver.id)).toHaveLength(0);
    await service.dispose(); services.pop();
    service = (await module.WebhookService.open(x.options))!; services.push(service); service.attach(store, { isActive: () => false }, true);
    store.updateRun(run.id, { autoResumeAt: '2026-11-22T12:02:00Z' }); store.updateRun(run.id, { autoResumeAt: undefined }); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(x.dataDir, 'webhooks/failure-episodes.json'), 'utf8')).episodes[run.id]).toBeDefined();
  });
  it('keeps the newest failure episode when several transitions precede admission', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'failed' }); store.updateRun(run.id, { status: 'running' }); store.updateRun(run.id, { status: 'failed' });
    x.time(Date.parse('2026-10-13T12:01:00Z')); await service.tick(); await service.tick();
    expect(x.send).toHaveBeenCalledTimes(1);
    expect(service.deliveries(receiver.receiver.id).map(item => item.status)).toEqual(['superseded', 'delivered']);
  });
  it('does not resurrect an old waiting episode while draining the outbox', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com', graceSeconds: 0 }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] });
    store.updateRun(run.id, { status: 'waiting' }); store.updateRun(run.id, { status: 'running' });
    await service.pause(receiver.receiver.id, 2);
    store.updateRun(run.id, { status: 'waiting' });
    await service.resume(receiver.receiver.id, 3); await service.tick();
    expect(x.send).not.toHaveBeenCalled();
  });

  it('tests inactive receivers once and exposes a read-only deleted history', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' });
    const input = { expectedRevision: 1, deliveryRevision: 1, operationId: 'same-click' };
    const first = await service.test(receiver.receiver.id, input);
    expect(await service.test(receiver.receiver.id, input)).toEqual(first);
    await service.tick(); expect(x.send).toHaveBeenCalledTimes(1);
    expect(service.list().receivers[0]!.state).toBe('inactive');
    await service.delete(receiver.receiver.id, service.list().receivers[0]!.revision);
    const page = service.deliveryPage(receiver.receiver.id, { limit: 100 });
    expect(page.receiver.kind).toBe('history'); expect(page.items).toHaveLength(1);
    expect(page.items[0]!.replayAllowed).toBe(false);
    expect(service.activityPage(receiver.receiver.id).items.some(row => row.action === 'test')).toBe(true);
  });
  it('replays retained terminal bytes once per operation with the same event ID', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); await service.tick();
    const original = service.deliveries(receiver.receiver.id)[0]!;
    x.time(Date.parse('2026-10-14T12:00:00Z'));
    const input = { expectedRevision: service.list().receivers[0]!.revision, deliveryRevision: 1, operationId: 'replay-click' };
    const replay = await service.replay(original.id, input); expect(await service.replay(original.id, input)).toEqual(replay);
    await service.tick(); expect(x.send).toHaveBeenCalledTimes(2);
    expect(x.send.mock.calls[1]![0].body).toBe(x.send.mock.calls[0]![0].body);
    expect(x.send.mock.calls[1]![0].eventId).toBe(x.send.mock.calls[0]![0].eventId);
    expect(replay.deliveryId).not.toBe(original.id);
  });

  it('rejects a fourth queued test for the same host while an idempotent retry remains free', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); const service = (await module.WebhookService.open(x.options))!; services.push(service);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' });
    const first = { expectedRevision: 1, deliveryRevision: 1, operationId: 'one' };
    const result = await service.test(receiver.receiver.id, first);
    await service.test(receiver.receiver.id, { ...first, expectedRevision: 2, operationId: 'two' });
    await service.test(receiver.receiver.id, { ...first, expectedRevision: 3, operationId: 'three' });
    await expect(service.test(receiver.receiver.id, { ...first, expectedRevision: 4, operationId: 'four' })).rejects.toMatchObject({ status: 429 });
    expect(await service.test(receiver.receiver.id, first)).toEqual(result);
  });

  it('retains hosted activation policy after restarting in local mode', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open({ ...x.options, mode: 'hosted' }))!; services.push(service);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    await service.dispose(); services.pop();
    service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'done' }); await service.tick();
    expect(x.send.mock.calls[0]![0].policy.mode).toBe('hosted');
  });

  it('retires failure identities on archival and when a restarted owner sees a completed task', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const x = await setup(); let service = (await module.WebhookService.open(x.options))!; services.push(service);
    const store = RunStore.open(x.dataDir); stores.push(store); service.attach(store, { isActive: () => false }, true);
    const receiver = await service.create({ name: 'Ops', url: 'https://example.com' }); await service.activate(receiver.receiver.id, 1);
    const run = store.createRun({ title: 'task', task: 'task', workflow: 'w', steps: [] }); store.updateRun(run.id, { status: 'failed' });
    x.time(Date.parse('2026-10-13T12:01:00Z')); await service.tick();
    const index = () => JSON.parse(readFileSync(join(x.dataDir, 'webhooks/failure-episodes.json'), 'utf8')).episodes;
    expect(index()[run.id]).toBeDefined();
    store.setArchived(run.id, true); await service.tick(); expect(index()[run.id]).toBeUndefined();
    store.setArchived(run.id, false); store.updateRun(run.id, { status: 'running' }); store.updateRun(run.id, { status: 'failed' });
    x.time(Date.parse('2026-10-13T12:02:00Z')); await service.tick(); expect(index()[run.id]).toBeDefined();
    await service.dispose(); services.pop(); store.updateRun(run.id, { status: 'done' });
    service = (await module.WebhookService.open(x.options))!; services.push(service); service.attach(store, { isActive: () => false }, true);
    await service.tick(); expect(index()[run.id]).toBeUndefined();
  });

  it('resets a copied project without using its inherited receivers, keys or live-owner lock', async () => {
    vi.stubEnv('CEZ_WEBHOOKS', '1'); const a = await setup(); const original = (await module.WebhookService.open(a.options))!; services.push(original);
    const created = await original.create({ name: 'Original', url: 'https://example.com' }); await original.activate(created.receiver.id, 1);
    const b = await setup(); cpSync(a.dataDir, b.dataDir, { recursive: true });
    const copy = (await module.WebhookService.open(b.options))!; services.push(copy);
    expect(copy.list().receivers).toHaveLength(0); expect(copy.list().webhookHealth.reason).toContain('copied');
    expect(original.list().receivers[0]!.state).toBe('active');
    await copy.tick(); expect(b.send).not.toHaveBeenCalled();
  });

});
