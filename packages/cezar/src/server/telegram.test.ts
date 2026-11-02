import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { telegramDomainErrorSchema, telegramInboundStateResponseSchema } from '@open-mercato/cezar-contract';
import { createTelegramRoutes } from './telegram.ts';
import { TelegramInboundFailure, type TelegramInbound } from '../telegram/service.ts';

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
it('validates typed bodies before any setup action and blocks disabled mutations', async () => {
  const beginSetup = vi.fn(), service = { beginSetup } as unknown as TelegramInbound;
  let reason: 'flag_off' | undefined;
  const app = createTelegramRoutes(async () => service, () => reason);
  const request = () => app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect((await request()).status).toBe(400); expect(beginSetup).not.toHaveBeenCalled();
  reason = 'flag_off';
  const blocked = await request(); expect(blocked.status).toBe(503);
  expect(await blocked.json()).toMatchObject({ code: 'flag_off' }); expect(beginSetup).not.toHaveBeenCalled();
});
it('answers activity and setup reads empty while inbound is unavailable', async () => {
  const activity = vi.fn(() => ({ entries: [{ id: 'secret' }] })), setupStatus = vi.fn(() => ({ status: 'waiting' }));
  const inbound = { activity, setupStatus } as unknown as TelegramInbound;
  let reason: 'hosted' | 'flag_off' | undefined = 'hosted';
  const app = createTelegramRoutes(async () => inbound, () => reason);
  const id = '00000000-0000-4000-8000-000000000000';
  for (const next of ['hosted', 'flag_off'] as const) {
    reason = next;
    const listed = await app.request('/telegram/activity');
    expect(listed.status).toBe(200); expect(await listed.json()).toEqual({ entries: [] });
    const status = await app.request(`/telegram/setup/${id}`);
    expect(status.status).toBe(404); expect(await status.json()).toMatchObject({ code: 'pairing_expired' });
  }
  expect(activity).not.toHaveBeenCalled(); expect(setupStatus).not.toHaveBeenCalled();
  reason = undefined;
  expect((await app.request(`/telegram/setup/${id}`)).status).toBe(200); expect(setupStatus).toHaveBeenCalledTimes(1);
});
it('chains validated setup operations and never reflects a submitted token', async () => {
  const setupId = '00000000-0000-4000-8000-000000000000';
  const begun = { setupId, receiverId: 'receiver', bot: { id: '123', username: 'safe_bot' }, expiresAt: 1000, deepLink: 'https://t.me/safe_bot?start=x' };
  const beginSetup = vi.fn(async () => begun), setupStatus = vi.fn(() => ({ status: 'waiting' as const, receiverId: 'receiver', bot: begun.bot, inboundRevision: 'a'.repeat(64) }));
  const activateSetup = vi.fn(async () => ({ grant: {}, inboundRevision: 'b'.repeat(64) })), cancelSetup = vi.fn(() => ({ cancelled: true as const }));
  const app = createTelegramRoutes(async () => ({ beginSetup, setupStatus, activateSetup, cancelSetup } as unknown as TelegramInbound), () => undefined);
  const body = { receiverId: 'receiver', expectedRevision: 'a'.repeat(64), dedicatedBot: true, groupVisibilityAccepted: true };
  const response = await app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  expect(response.status).toBe(201); expect(result).toEqual(begun); expect(JSON.stringify(result)).not.toContain('token');
  expect((await app.request(`/telegram/setup/${setupId}`)).status).toBe(200);
  const activation = { activate: true, expectedRevision: 'a'.repeat(64), candidateUserId: '123', comparisonVerified: true, permissions: ['respond'] };
  expect((await app.request(`/telegram/setup/${setupId}/activate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(activation) })).status).toBe(200);
  expect((await app.request(`/telegram/setup/${setupId}`, { method: 'DELETE' })).status).toBe(200);
  expect(beginSetup).toHaveBeenCalledWith(body); expect(setupStatus).toHaveBeenCalledWith(setupId);
  expect(activateSetup).toHaveBeenCalledWith(setupId, activation); expect(cancelSetup).toHaveBeenCalledWith(setupId);
});
it('setup always needs the dedicated-bot acknowledgement and activation needs answering permission', async () => {
  const beginSetup = vi.fn(), activateSetup = vi.fn();
  const app = createTelegramRoutes(async () => ({ beginSetup, activateSetup } as unknown as TelegramInbound), () => undefined);
  const post = (path: string, body: unknown) => app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect((await post('/telegram/setup', { receiverId: 'receiver', expectedRevision: 'a'.repeat(64) })).status).toBe(400);
  expect((await post('/telegram/setup', { receiverId: 'receiver', expectedRevision: 'a'.repeat(64), dedicatedBot: false })).status).toBe(400);
  const activate = { activate: true, expectedRevision: 'a'.repeat(64), candidateUserId: '123' };
  for (const extra of [{}, { permissions: ['cancel'] }]) expect((await post('/telegram/setup/00000000-0000-4000-8000-000000000000/activate', { ...activate, ...extra })).status).toBe(400);
  expect(beginSetup).not.toHaveBeenCalled(); expect(activateSetup).not.toHaveBeenCalled();
});
it('serves no separate pairing routes: guided setup is the only way to pair', async () => {
  const pair = vi.fn(), confirm = vi.fn(), pairing = vi.fn();
  const app = createTelegramRoutes(async () => ({ pair, confirm, pairing } as unknown as TelegramInbound), () => undefined);
  const id = '00000000-0000-4000-8000-000000000000', json = { 'content-type': 'application/json' };
  for (const [method, path] of [['POST', '/telegram/pairings'], ['GET', `/telegram/pairings/${id}`], ['POST', `/telegram/pairings/${id}/confirm`], ['DELETE', `/telegram/pairings/${id}`]] as const) {
    const response = await app.request(path, { method, headers: json, ...(method === 'POST' ? { body: JSON.stringify({ receiverId: 'r', expectedRevision: 'a'.repeat(64), dedicatedBot: true, candidateUserId: '1' }) } : {}) });
    expect(response.status, `${method} ${path}`).toBe(404);
  }
  expect(pair).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled(); expect(pairing).not.toHaveBeenCalled();
});
it('projects the setup recovery error matrix with exact statuses and schema', async () => {
  const setupId = '00000000-0000-4000-8000-000000000000';
  for (const [code, status] of [['invalid_token', 400], ['pairing_expired', 404], ['conflict', 409], ['blocked', 409],
    ['damaged_state', 409], ['vault_unavailable', 503]] as const) {
    const beginSetup = vi.fn(async () => { throw new TelegramInboundFailure(status, code); });
    const app = createTelegramRoutes(async () => ({ beginSetup } as unknown as TelegramInbound), () => undefined);
    const response = await app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ receiverId: 'r', expectedRevision: 'a'.repeat(64), dedicatedBot: true }) });
    expect(response.status, code).toBe(status);
    expect(telegramDomainErrorSchema.parse(await response.json())).toEqual({ error: code, code });
  }
  for (const reason of ['hosted', 'flag_off'] as const) {
    const app = createTelegramRoutes(async () => undefined, () => reason);
    const read = await app.request(`/telegram/setup/${setupId}`);
    expect(read.status).toBe(404); expect(await read.json()).toEqual({ error: 'pairing_expired', code: 'pairing_expired' });
  }
});
it('preserves project-scope 404 and 409 failures before resolving setup state', async () => {
  const resolve = vi.fn(async () => undefined);
  for (const [projectId, status, code] of [['missing', 404, 'project_missing'], ['gone', 409, 'project_unavailable']] as const) {
    const family = createTelegramRoutes(resolve, () => undefined, async id => { if (id === projectId) throw new TelegramInboundFailure(status, code); });
    const app = new Hono().route('/p/:projectId', family);
    const response = await app.request(`/p/${projectId}/telegram`);
    expect(response.status).toBe(status); expect(await response.json()).toEqual({ error: code, code });
  }
  expect(resolve).not.toHaveBeenCalled();
});
it('gates setup mutations in hosted mode before service work', async () => {
  const beginSetup = vi.fn();
  const app = createTelegramRoutes(async () => ({ beginSetup } as unknown as TelegramInbound), () => 'hosted');
  const response = await app.request('/telegram/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ receiverId: 'r', expectedRevision: 'a'.repeat(64), dedicatedBot: true }) });
  expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ code: 'hosted' }); expect(beginSetup).not.toHaveBeenCalled();
});
