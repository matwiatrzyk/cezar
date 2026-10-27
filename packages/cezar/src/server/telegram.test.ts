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
