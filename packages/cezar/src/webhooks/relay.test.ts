import { createHmac, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
const path = new URL('../../docs/webhook-relay.mjs', import.meta.url).href;
const relay = await import(path);
const roots: string[] = [];
const now = Date.parse('2026-10-13T12:00:00Z');
const key = randomBytes(32); const secret = `whsec_${key.toString('base64')}`;
const event = (type = 'task.finished', id = 'evt_1') => ({ id, type, schemaVersion: 1, occurredAt: new Date(now).toISOString(), source: { projectId: 'project' }, task: { id: 'task-1', title: '<!channel> @everyone & hello' }, data: { resolution: 'completed' } });
function request(value = event()) {
  const raw = Buffer.from(JSON.stringify(value)); const timestamp = String(now / 1000);
  return { raw, headers: { 'webhook-id': value.id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${createHmac('sha256', key).update(`${value.id}.${timestamp}.`).update(raw).digest('base64')}` } };
}
async function setup() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'webhook-relay-test-')); roots.push(directory);
  const store = await relay.openCompletedStore(join(directory, 'completed.json'), { now: () => now });
  const post = vi.fn(async () => {});
  return { store, post, file: join(directory, 'completed.json'), handle: relay.createRelay({ secrets: [secret], store, post, now: () => now }) };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe('standalone webhook relay', () => {
  it('authenticates exact raw bytes and timestamp before parsing or forwarding', async () => {
    const x = await setup(); const input = request();
    expect(await x.handle({ ...input, raw: Buffer.concat([input.raw, Buffer.from(' ')]) })).toBe(401);
    expect(await x.handle({ ...input, headers: { ...input.headers, 'webhook-timestamp': String(now / 1000 - 301) } })).toBe(401);
    expect(x.post).not.toHaveBeenCalled();
    expect(await x.handle(input)).toBe(204);
  });
  it('serializes concurrent same-ID arrivals and retains completion across restart', async () => {
    const x = await setup();
    expect(await Promise.all([x.handle(request()), x.handle(request())])).toEqual([204, 204]);
    expect(x.post).toHaveBeenCalledTimes(1);
    const store = await relay.openCompletedStore(x.file, { now: () => now });
    const handle = relay.createRelay({ secrets: [secret], store, post: x.post, now: () => now });
    expect(await handle(request())).toBe(204); expect(x.post).toHaveBeenCalledTimes(1);
  });
  it('does not mark a failed chat post completed', async () => {
    const x = await setup(); x.post.mockRejectedValueOnce(new Error('private destination'));
    expect(await x.handle(request())).toBe(503); expect(await x.handle(request())).toBe(204);
    expect(x.post).toHaveBeenCalledTimes(2);
  });
  it('returns retryable failure when completion cannot be saved after a successful post', async () => {
    const post = vi.fn(async () => {}); let saved = false;
    const complete = vi.fn(async () => { if (!saved) { saved = true; throw new Error('disk full'); } });
    const handle = relay.createRelay({ secrets: [secret], store: { has: () => false, complete }, post, now: () => now });
    expect(await handle(request())).toBe(503); expect(await handle(request())).toBe(204);
    expect(post).toHaveBeenCalledTimes(2); // Documented uncertain-outcome duplicate.
  });
  it('serializes durable updates for different IDs without losing either completion', async () => {
    const x = await setup(); await Promise.all([x.handle(request(event('task.finished', 'evt_a'))), x.handle(request(event('task.finished', 'evt_b')))]);
    const store = await relay.openCompletedStore(x.file, { now: () => now });
    expect(store.has('evt_a')).toBe(true); expect(store.has('evt_b')).toBe(true);
  });
  it('summarizes every event and neutralizes chat mention syntax', () => {
    for (const type of ['task.attention_required', 'task.review_ready', 'task.finished', 'task.failed', 'task.cancelled', 'webhook.test']) {
      const summary = relay.summarize(event(type)); expect(summary).toBeTruthy();
      expect(relay.chatPayload(summary, 'slack').text).not.toContain('<!channel>');
      expect(relay.chatPayload(summary, 'discord').allowed_mentions).toEqual({ parse: [] });
    }
    expect(relay.summarize({ ...event('task.failed'), data: { disposition: 'scheduled', autoResumeAt: '2026-10-13T12:05:00Z' } })).toContain('resumes at');
  });
});
