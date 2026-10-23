import { expect, it, vi } from 'vitest';
import { runTrackerCommand } from './task-cli.ts';
const env = { CEZ_API_URL: 'http://127.0.0.1:1234', CEZ_PROJECT_ID: 'example', CEZ_TRACKER_CAPABILITY: 'synthetic-session-capability' };
it('refuses a missing capability or non-loopback server without making requests', async () => {
  const io = { fetch: vi.fn(), log: vi.fn(), error: vi.fn() };
  expect(await runTrackerCommand(['read'], {}, io)).toBe(2);
  expect(await runTrackerCommand(['read'], { ...env, CEZ_API_URL: 'https://example.com' }, io)).toBe(2);
  expect(io.fetch).not.toHaveBeenCalled();
  expect(JSON.stringify(io.error.mock.calls)).not.toContain(env.CEZ_TRACKER_CAPABILITY);
});
it('sends typed status actions with a stable ID, carries the capability only in a header, and surfaces unknown results', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const io = { fetch: vi.fn(async () => new Response(JSON.stringify({ operationId: id, status: 'unknown', message: 'Inspect issue.' }))), log: vi.fn(), error: vi.fn() };
  expect(await runTrackerCommand(['transition', '--id', id, '--transition', 'done', '--expected-status', 'todo'], env, io)).toBe(2);
  expect(io.fetch).toHaveBeenCalledWith('http://127.0.0.1:1234/api/v1/p/example/tracker/task', expect.objectContaining({ redirect: 'error', headers: { Authorization: `Bearer ${env.CEZ_TRACKER_CAPABILITY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId: id, action: { kind: 'transition', transitionId: 'done', expectedStatusId: 'todo' } }) }));
  expect(JSON.stringify(io.log.mock.calls)).not.toContain(env.CEZ_TRACKER_CAPABILITY);
});
