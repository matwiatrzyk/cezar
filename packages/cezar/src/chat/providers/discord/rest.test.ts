import { afterEach, describe, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { discordRequest } from './rest.ts';
const previous = getGlobalDispatcher(); let mock: MockAgent | undefined;
afterEach(async () => { setGlobalDispatcher(previous); await mock?.close(); });
function wire() { mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock); return mock.get('https://discord.com'); }
describe('Discord HTTP wire', () => {
 it('classifies 429 retry_after and holds further effects without leaking body', async () => {
  const pool = wire(); pool.intercept({ method: 'POST', path: '/api/v10/channels/10/messages' }).reply(429, { retry_after: 1.25, token: 'must-not-leak' });
  const request = discordRequest('simulated-token');
  await expect(request('POST', '/channels/10/messages', { content: 'hello' })).rejects.toMatchObject({ failure: { kind: 'rate_limited', retryAfterMs: 1250 } });
  await expect(request('POST', '/channels/10/messages', {})).rejects.toMatchObject({ failure: { kind: 'rate_limited' } });
 });
 it('does not retry ambiguous POST transport failure while GET may retry', async () => {
  const pool = wire(); pool.intercept({ method: 'POST', path: '/api/v10/channels/10/messages' }).replyWithError(new Error('token must not leak'));
  pool.intercept({ method: 'GET', path: '/api/v10/users/@me' }).replyWithError(new Error('secret'));
  const request = discordRequest('simulated-token');
  await expect(request('POST', '/channels/10/messages', {})).rejects.toMatchObject({ message: 'Chat transport: blocked', failure: { kind: 'blocked' } });
  await expect(request('GET', '/users/@me')).rejects.toMatchObject({ message: 'Chat transport: transient', failure: { kind: 'transient' } });
 });
 it('refuses redirects and guard revocation before any request', async () => {
  const pool = wire(); pool.intercept({ method: 'GET', path: '/api/v10/users/@me' }).reply(302, '', { headers: { location: 'https://example.com' } });
  await expect(discordRequest('token')('GET', '/users/@me')).rejects.toThrow('Chat transport: transient');
  await expect(discordRequest('token', () => false)('POST', '/channels/10/messages', {})).rejects.toThrow('Chat transport: blocked');
 });
 it('scopes an exhausted bucket to its route and major parameter', async () => {
  const pool = wire(), limited = { headers: { 'x-ratelimit-bucket': 'b1', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '5' } };
  pool.intercept({ method: 'POST', path: '/api/v10/channels/10/messages' }).reply(200, { id: '1' }, limited);
  pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(200, { id: '30' });
  pool.intercept({ method: 'POST', path: '/api/v10/channels/11/messages' }).reply(200, { id: '2' });
  const request = discordRequest('simulated-token');
  await request('POST', '/channels/10/messages', {});
  await expect(request('GET', '/channels/30')).resolves.toEqual({ id: '30' });
  await expect(request('POST', '/channels/11/messages', {})).resolves.toEqual({ id: '2' });
  await expect(request('POST', '/channels/10/messages', {})).rejects.toMatchObject({ failure: { kind: 'rate_limited' } });
  mock!.assertNoPendingInterceptors();
 });
 it('holds every route only on a global rate limit', async () => {
  const pool = wire(); pool.intercept({ method: 'POST', path: '/api/v10/channels/10/messages' }).reply(429, { retry_after: 2, global: true }, { headers: { 'x-ratelimit-global': 'true', 'x-ratelimit-scope': 'global' } });
  const request = discordRequest('simulated-token');
  await expect(request('POST', '/channels/10/messages', {})).rejects.toMatchObject({ failure: { kind: 'rate_limited', retryAfterMs: 2000 } });
  await expect(request('GET', '/channels/30')).rejects.toMatchObject({ failure: { kind: 'rate_limited' } });
 });
 it('keeps a route cooldown recorded before its bucket hash was learned', async () => {
  const pool = wire();
  pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(200, { id: '30' }, { headers: { 'x-ratelimit-bucket': 'b1', 'x-ratelimit-remaining': '1' } }).delay(100);
  pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(429, { retry_after: 5 });
  pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(200, { id: '30' });
  const request = discordRequest('simulated-token');
  const [slow, limited] = await Promise.allSettled([request('GET', '/channels/30'), request('GET', '/channels/30')]);
  expect(slow).toMatchObject({ status: 'fulfilled' }); expect(limited).toMatchObject({ status: 'rejected' });
  await expect(request('GET', '/channels/30')).rejects.toMatchObject({ failure: { kind: 'rate_limited' } });
 });
 it('evicts expired cooldowns before a live one', async () => {
  const pool = wire(), request = discordRequest('simulated-token');
  pool.intercept({ method: 'POST', path: '/api/v10/channels/1/messages' }).reply(200, { id: '1' }, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '60' } });
  for (let id = 2; id <= 513; id++) pool.intercept({ method: 'POST', path: `/api/v10/channels/${id}/messages` }).reply(200, { id: '1' }, { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '0.001' } });
  for (let id = 1; id <= 513; id++) await request('POST', `/channels/${id}/messages`, {});
  await expect(request('POST', '/channels/1/messages', {})).rejects.toMatchObject({ failure: { kind: 'rate_limited' } });
 });
});
