import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { telegramInboundStateResponseSchema } from '@open-mercato/cezar-contract';
import { createTelegramRoutes } from './telegram.ts';
import type { TelegramInbound } from '../telegram/service.ts';

it('serves disabled state through every alias without falling through to project recovery', async () => {
  const resolve = vi.fn(async () => undefined), recovery = vi.fn();
  const family = new Hono().route('/', createTelegramRoutes(resolve, () => 'flag_off'))
    .use('*', async (_c, next) => { recovery(); await next(); });
  const app = new Hono().route('/api/v1/p/:projectId', family).route('/api/v1', family);
  for (const prefix of ['/api/v1', '/api/v1/p/default', '/api/v1/p/project']) {
    const result = await app.request(`${prefix}/telegram`);
    expect(result.status).toBe(200); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(telegramInboundStateResponseSchema.parse(await result.json())).toMatchObject({ available: false, reason: 'flag_off' });
    expect((await app.request(`${prefix}/telegram/unknown`)).status).toBe(404);
  }
  expect(recovery).not.toHaveBeenCalled();
});
it('withholds configured Telegram data while inbound is unavailable', async () => {
  const inbound = { refreshDiagnostics: vi.fn(), list: vi.fn(() => ({ available: true, receivers: [{ receiverId: 'secret', inboundRevision: 'a'.repeat(64), state: 'active' as const }], bots: [], grants: [] })) } as unknown as TelegramInbound;
  const app = createTelegramRoutes(async () => inbound, () => 'hosted');
  const response = await app.request('/telegram');
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ available: false, reason: 'hosted', receivers: [], bots: [], grants: [] });
  expect(inbound.list).not.toHaveBeenCalled();
});
it('validates project scope before returning unavailable without opening webhook storage', async () => {
  const resolve = vi.fn(async () => { throw new Error('storage must not be opened'); });
  const validate = vi.fn(async (projectId: string | undefined) => {
    if (projectId === 'missing') throw new Error('scope missing');
  });
  const app = createTelegramRoutes(resolve, () => 'flag_off', validate);
  const response = await app.request('/telegram');
  expect(response.status).toBe(200);
  expect(resolve).not.toHaveBeenCalled();
  expect(validate).toHaveBeenCalledWith(undefined);
});
it('validates typed bodies before any pairing action and blocks disabled mutations', async () => {
  const pair = vi.fn(), service = { pair } as unknown as TelegramInbound;
  let reason: 'flag_off' | undefined;
  const app = createTelegramRoutes(async () => service, () => reason);
  const request = () => app.request('/telegram/pairings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect((await request()).status).toBe(400); expect(pair).not.toHaveBeenCalled();
  reason = 'flag_off';
  const blocked = await request(); expect(blocked.status).toBe(503);
  expect(await blocked.json()).toMatchObject({ code: 'flag_off' }); expect(pair).not.toHaveBeenCalled();
});
it('answers activity and pairing reads empty while inbound is unavailable', async () => {
  const activity = vi.fn(() => ({ entries: [{ id: 'secret' }] })), pairing = vi.fn(() => ({ status: 'waiting' }));
  const inbound = { activity, pairing } as unknown as TelegramInbound;
  let reason: 'hosted' | 'flag_off' | undefined = 'hosted';
  const app = createTelegramRoutes(async () => inbound, () => reason);
  const id = '00000000-0000-4000-8000-000000000000';
  for (const next of ['hosted', 'flag_off'] as const) {
    reason = next;
    const listed = await app.request('/telegram/activity');
    expect(listed.status).toBe(200); expect(await listed.json()).toEqual({ entries: [] });
    const status = await app.request(`/telegram/pairings/${id}`);
    expect(status.status).toBe(404); expect(await status.json()).toMatchObject({ code: 'pairing_expired' });
  }
  expect(activity).not.toHaveBeenCalled(); expect(pairing).not.toHaveBeenCalled();
  reason = undefined;
  expect((await app.request(`/telegram/pairings/${id}`)).status).toBe(200); expect(pairing).toHaveBeenCalledTimes(1);
});
