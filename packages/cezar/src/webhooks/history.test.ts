import { readdirSync, realpathSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WebhookHistory, pageRecords } from './history.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('bounded scoped webhook history', () => {
  it('pages stable snapshots, excludes concurrent new rows and rejects another scope', () => {
    const rows = [1, 2, 3, 4].map(id => ({ id: String(id), at: `2026-10-13T12:00:0${id}Z` }));
    const first = pageRecords(rows, 'project/receiver/task', { limit: 2 });
    expect(first.items.map(item => item.id)).toEqual(['4', '3']);
    const next = pageRecords([...rows, { id: '5', at: '2026-10-13T12:00:05Z' }], 'project/receiver/task', { limit: 2, cursor: first.nextCursor });
    expect(next.items.map(item => item.id)).toEqual(['2', '1']); expect(next.hasMore).toBe(false);
    expect(() => pageRecords(rows, 'project/other/task', { limit: 2, cursor: first.nextCursor })).toThrow('cursor');
  });
  it('keeps masked latest results across restart, bounded by age and bytes', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-history-')); dirs.push(dir); let now = Date.parse('2026-10-13T12:00:00Z');
    let history = await WebhookHistory.open(dir, () => now, 1000);
    for (let index = 0; index < 12; index++) await history.activity('receiver', { id: String(index), at: new Date(now++).toISOString(), action: 'test', source: 'cockpit/api', fields: [], detail: 'https://secret.example/path?token=hidden' }, ['https://secret.example/path?token=hidden']);
    history = await WebhookHistory.open(dir, () => now, 1000);
    expect(history.activities('receiver').length).toBeGreaterThan(0); expect(history.activities('receiver').length).toBeLessThan(12);
    expect(JSON.stringify(history.activities('receiver'))).not.toContain('token=hidden');
    now += 31 * 86400000; await history.prune();
    expect(history.activities('receiver')).toHaveLength(0);
  });
  // Spec §"Storage, privacy and degradation": malformed state disables nothing beyond this
  // project's webhooks, and users must not repair JSON by hand. History is display data, so a
  // bad row is quarantined and the service keeps serving new deliveries.
  it('quarantines an unreadable delivery or activity log instead of bricking the service', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'webhook-history-')); dirs.push(dir);
    writeFileSync(join(dir, 'deliveries.ndjson'), '{"deliveryId":"not-a-delivery"}\n');
    writeFileSync(join(dir, 'activity.ndjson'), 'not json\n');
    const history = await WebhookHistory.open(dir);
    expect(history.wasReset).toBe(true);
    expect(history.results('receiver')).toEqual([]);
    expect(history.activities('receiver')).toEqual([]);
    const files = readdirSync(dir);
    expect(files.some(name => name.startsWith('deliveries.ndjson.corrupt-'))).toBe(true);
    expect(files.some(name => name.startsWith('activity.ndjson.corrupt-'))).toBe(true);
    const reopened = await WebhookHistory.open(dir);
    expect(reopened.wasReset).toBe(false);
  });
});
