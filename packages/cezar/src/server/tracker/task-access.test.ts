import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { executeTrackerOperation, trackerTaskContext, type TrackerTaskBinding } from './task-access.ts';
const mock = vi.hoisted(() => ({ driver: vi.fn() }));
vi.mock('./index.ts', () => ({ createTrackerService: () => mock }));
let dir: string;
const association = { kind: 'linear' as const, connectionId: 'c', source: { id: 's', webUrl: 'https://linear.app/a' }, externalId: 'team', externalName: 'Team' };
const binding: TrackerTaskBinding = { automationId: 'a', automationRevision: 1, receiptId: 'r', provider: 'linear', association, issueId: 'issue', key: 'ABC-1', url: 'https://linear.app/a', access: { version: 1, writes: ['comment', 'transition'] } };
const action = { kind: 'comment' as const, body: 'Ready for review' };
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'tracker-ops-')); });
afterEach(async () => { vi.resetAllMocks(); await rm(dir, { recursive: true, force: true }); });
it('records before sending and replays completed results without posting again', async () => {
  const act = vi.fn(async () => {
    const names = await readdir(join(dir, 'runs', 'run.tracker-operations'));
    const persisted = JSON.parse(await readFile(join(dir, 'runs', 'run.tracker-operations', names[0]!), 'utf8'));
    expect(persisted.result.status).toBe('unknown');
  });
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const input = { operationId: randomUUID(), action };
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('completed');
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('completed');
  expect(act).toHaveBeenCalledTimes(1);
  expect((await executeTrackerOperation(dir, dir, 'run', binding, { ...input, action: { ...action, body: 'Changed' } })).status).toBe('rejected');
});
it('keeps a timeout unknown across retries and does not issue a second request', async () => {
  const act = vi.fn().mockRejectedValue(new Error('response lost after commit'));
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const input = { operationId: randomUUID(), action };
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('unknown');
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input)).status).toBe('unknown');
  expect(act).toHaveBeenCalledTimes(1);
});
it('serializes distinct operations for the same issue across runs', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const act = vi.fn(() => gate);
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act });
  const first = executeTrackerOperation(dir, dir, 'first', binding, { operationId: randomUUID(), action });
  await vi.waitFor(() => expect(act).toHaveBeenCalledTimes(1));
  const second = await executeTrackerOperation(dir, dir, 'second', binding, { operationId: randomUUID(), action });
  expect(second.status).toBe('unknown');
  expect(act).toHaveBeenCalledTimes(1);
  release(); await first;
});
it('denies writes before touching the provider when they were not granted', async () => {
  const result = await executeTrackerOperation(dir, dir, 'run', { ...binding, access: { version: 1, writes: [] } }, { operationId: randomUUID(), action });
  expect(result.status).toBe('rejected'); expect(mock.driver).not.toHaveBeenCalled();
});
it('refuses changed bindings and an issue identity substituted by the provider', async () => {
  mock.driver.mockResolvedValue({ association: { ...association, connectionId: 'rotated' }, context: vi.fn() });
  await expect(trackerTaskContext(dir, binding)).rejects.toThrow();
  mock.driver.mockResolvedValue({ association, context: vi.fn().mockResolvedValue({ issueId: 'another' }) });
  await expect(trackerTaskContext(dir, binding)).rejects.toThrow();
});

it('rechecks a cancelled or superseded task immediately before the provider write', async () => {
  const send = vi.fn();
  mock.driver.mockResolvedValue({ association, context: vi.fn(), act: async (_id: string, _action: unknown, beforeWrite: () => Promise<void>) => { await beforeWrite(); send(); } });
  const input = { operationId: randomUUID(), action };
  expect((await executeTrackerOperation(dir, dir, 'run', binding, input, () => false)).status).toBe('unknown');
  expect(send).not.toHaveBeenCalled();
});
