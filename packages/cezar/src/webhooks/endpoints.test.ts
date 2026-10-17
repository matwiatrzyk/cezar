import { randomUUID } from 'node:crypto';
import { realpathSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import * as endpoints from './endpoints.ts';
const dirs: string[] = [];
async function setup() {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-endpoints-')); dirs.push(dir);
  let sequence = 0; let now = Date.parse('2026-10-13T12:00:00Z');
  const registry = await endpoints.EndpointRegistry.open(dir, { installationId: 'inst_test', highWater: () => sequence, now: () => now, assertOwner() {} });
  return { registry, dir, sequence: (value: number) => { sequence = value; }, time: (value: number) => { now = value; } };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('webhook endpoint configuration and activation fences', () => {
  it('applies a recovered result once and keeps revision fences authoritative', async () => {
    const x = await setup(); const { receiver } = await x.registry.create({ name: 'Ops', url: 'https://example.com' });
    await x.registry.activate(receiver.id, 1);
    const receipt = { token: randomUUID(), at: '2026-10-13T12:00:00.000Z' };
    await x.registry.deliveryResult(receiver.id, 2, 1, 'transient', false, receipt);
    const reopened = await endpoints.EndpointRegistry.open(x.dir, { installationId: 'inst_test', highWater: () => 0, now: () => Date.parse(receipt.at), assertOwner() {} });
    await reopened.deliveryResult(receiver.id, 2, 1, 'transient', false, receipt);
    expect(reopened.list().receivers[0]!.consecutiveFailures).toBe(1);
    await reopened.pause(receiver.id, 2);
    await reopened.deliveryResult(receiver.id, 2, 1, 'gone', false, { ...receipt, token: randomUUID() });
    expect(reopened.list().receivers[0]!.state).toBe('paused');
  });
  it('creates Inactive Minimal with one-time key, exposing only a masked destination', async () => {
    const { registry } = await setup();
    const created = await registry.create({ name: 'Ops', url: 'https://example.com/private?token=hidden' });
    expect(created.secret.startsWith('whsec_')).toBe(true);
    expect(created.receiver).toMatchObject({ state: 'inactive', profile: 'minimal', revision: 1, deliveryRevision: 1 });
    expect(JSON.stringify(registry.list())).not.toContain('private'); expect(JSON.stringify(registry.list())).not.toContain('hidden');
    expect(JSON.stringify(registry.list())).not.toContain(created.secret);
  });
  it('uses sequence fences independent of wall clock and refreshes the fence on Resume', async () => {
    const x = await setup(); const { registry } = x; const created = await registry.create({ name: 'Ops', url: 'https://example.com' });
    x.sequence(10); const active = await registry.activate(created.receiver.id, 1);
    expect(registry.privateReceiver(active.id)?.activation?.sequence).toBe(10);
    const paused = await registry.pause(active.id, active.revision);
    x.time(1); x.sequence(20);
    const resumed = await registry.resume(active.id, paused.revision);
    expect(registry.privateReceiver(resumed.id)?.activation?.sequence).toBe(20);
  });
  it('reports why this server paused a receiver, and clears that reason on resume', async () => {
    const { registry } = await setup(); const created = await registry.create({ name: 'Ops', url: 'https://example.com' });
    const active = await registry.activate(created.receiver.id, 1);
    const paused = await registry.pause(active.id, active.revision, 'project_removal');
    expect(paused).toMatchObject({ state: 'paused', pauseReason: 'project_removal' });
    const resumed = await registry.resume(active.id, paused.revision);
    expect(resumed).toMatchObject({ state: 'active' });
    expect(resumed).not.toHaveProperty('pauseReason');
  });
  it('keeps a rename active but makes destination edits Inactive with a new delivery revision', async () => {
    const { registry } = await setup(); const created = await registry.create({ name: 'Ops', url: 'https://example.com' });
    const active = await registry.activate(created.receiver.id, 1);
    const renamed = await registry.update(active.id, { name: 'Renamed', url: 'https://example.com', expectedRevision: active.revision });
    expect(renamed).toMatchObject({ state: 'active', deliveryRevision: 1 });
    const edited = await registry.update(active.id, { name: 'Renamed', url: 'https://other.example.com', expectedRevision: renamed.revision });
    expect(edited).toMatchObject({ state: 'inactive', deliveryRevision: 2 });
    expect(registry.privateReceiver(active.id)?.activation).toBeUndefined();
    await expect(registry.pause(active.id, renamed.revision)).rejects.toThrow('revision');
  });
  it('forbids overlapping graceful rotation and supports immediate revocation', async () => {
    const { registry } = await setup(); const created = await registry.create({ name: 'Ops', url: 'https://example.com' });
    const rotated = await registry.rotate(created.receiver.id, 1, 'graceful');
    expect(registry.signingKeys(created.receiver.id)).toEqual([rotated.secret, created.secret]);
    await expect(registry.rotate(created.receiver.id, rotated.receiver.revision, 'graceful')).rejects.toThrow('overlap');
    const revoked = await registry.rotate(created.receiver.id, rotated.receiver.revision, 'revoke_now');
    expect(registry.signingKeys(created.receiver.id)).toEqual([revoked.secret]);
  });
  it('retains a permanent test block across transient errors and clears it only on current-revision success', async () => {
    const { registry } = await setup(); const created = await registry.create({ name: 'Ops', url: 'https://example.com' }); const id = created.receiver.id;
    await registry.testResult(id, 1, 1, 'permanent_failure');
    await registry.testResult(id, 1, 1, 'transient_failure');
    await expect(registry.activate(id, 1)).rejects.toThrow('test');
    await registry.testResult(id, 1, 1, 'success');
    expect((await registry.activate(id, 1)).state).toBe('active');
  });
  it('refuses activation if capture changes during every preparation without publishing Active', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-fence-')); dirs.push(dir);
    let sequence = 0;
    const registry = await endpoints.EndpointRegistry.open(dir, { installationId: 'inst_test', highWater: () => ++sequence, now: () => Date.now(), assertOwner() {} });
    const created = await registry.create({ name: 'Ops', url: 'https://example.com' });
    await expect(registry.activate(created.receiver.id, 1)).rejects.toThrow('Capture advanced');
    expect(registry.list().receivers[0]).toMatchObject({ state: 'inactive', revision: 1 });
  });
  it('acknowledges only the current notice and does not reopen it on acknowledgement', async () => {
    const { registry } = await setup();
    const created = await registry.create({ name: 'Ops', url: 'https://example.com' });
    const observed = registry.list().changeSequence;
    await registry.activate(created.receiver.id, 1);
    await expect(registry.acknowledge(observed)).rejects.toThrow('changed');
    await registry.acknowledge(registry.list().changeSequence);
    expect(registry.list().notice).toBeUndefined();
  });
  it('suspends after ten transient failures, ignores rate limits, and a successful test recovers the backlog fence', async () => {
    const { registry } = await setup(); const created = await registry.create({ name: 'Ops', url: 'https://example.com' });
    const active = await registry.activate(created.receiver.id, 1);
    for (let i = 0; i < 9; i++) await registry.deliveryResult(active.id, active.revision, 1, 'transient', false);
    await registry.deliveryResult(active.id, active.revision, 1, 'rate_limited', false);
    expect(registry.list().receivers[0]!.state).toBe('active');
    await registry.deliveryResult(active.id, active.revision, 1, 'transient', false);
    const suspended = registry.list().receivers[0]!;
    expect(suspended.state).toBe('suspended'); expect(suspended.nextProbeAt).toBeDefined();
    await registry.deliveryResult(active.id, suspended.revision, 1, 'success', true);
    expect(registry.list().receivers[0]!.state).toBe('active');
    expect(registry.privateReceiver(active.id)!.activation!.sequence).toBe(0);
  });
  it('does not reactivate a paused receiver from an old in-flight result', async () => {
    const { registry } = await setup(); const created = await registry.create({ name: 'Ops', url: 'https://example.com' });
    const active = await registry.activate(created.receiver.id, 1);
    await registry.pause(active.id, active.revision);
    await registry.deliveryResult(active.id, active.revision, 1, 'gone', false);
    expect(registry.list().receivers[0]!.state).toBe('paused');
  });
  it('does not reopen an acknowledged admin notice for an ordinary delivery result', async () => {
    const { registry } = await setup(); const created = await registry.create({ name: 'Ops', url: 'https://example.com' });
    const active = await registry.activate(created.receiver.id, 1);
    await registry.acknowledge(registry.list().changeSequence);
    await registry.deliveryResult(active.id, active.revision, 1, 'success', false);
    expect(registry.list().notice).toBeUndefined();
  });
  it('atomically deletes keys/configuration and retains only a historical identity', async () => {
    const { registry, dir } = await setup(); const created = await registry.create({ name: 'Ops', url: 'https://example.com/private' });
    await registry.delete(created.receiver.id, 1);
    expect(registry.list().receivers).toHaveLength(0);
    expect(registry.list().history[0]).toMatchObject({ kind: 'history', id: created.receiver.id, name: 'Ops' });
    expect(readFileSync(join(dir, 'endpoints.json'), 'utf8')).not.toContain(created.secret);
    expect(readFileSync(join(dir, 'endpoints.json'), 'utf8')).not.toContain('/private');
    await expect(registry.pause(created.receiver.id, 1)).rejects.toThrow('not found');
  });
  it('can rename without reading back or resubmitting the secret-bearing destination', async () => {
    const { registry } = await setup(); const created = await registry.create({ name: 'Ops', url: 'https://example.com/private?token=hidden' });
    await registry.activate(created.receiver.id, 1);
    const renamed = await registry.update(created.receiver.id, { name: 'New name', expectedRevision: 2 });
    expect(renamed.state).toBe('active'); expect(renamed.deliveryRevision).toBe(1);
    expect(registry.privateReceiver(renamed.id)!.url).toBe('https://example.com/private?token=hidden');
  });

});
