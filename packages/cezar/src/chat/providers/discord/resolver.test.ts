import { afterEach, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { ChatTransportError } from '../../provider.ts';
import { discordTransport } from './index.ts';

const token = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
const previous = getGlobalDispatcher();
let mock: MockAgent | undefined;
afterEach(async () => { setGlobalDispatcher(previous); await mock?.close(); mock = undefined; });
function wire() {
 mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
 return mock.get('https://discord.com');
}

it('preserves transient resolver failure through actual REST and recovers on the same transport', async () => {
 const pool = wire(); let calls = 0, unavailable = true;
 pool.intercept({ method: 'GET', path: '/api/v10/users/@me' }).reply(() => { calls++; return { statusCode: 200, data: { id: '1', username: 'Bot', bot: true } }; });
 const failure = new ChatTransportError({ kind: 'transient', retryAfterMs: 123 });
 const transport = discordTransport({ token: async () => { if (unavailable) throw failure; return token; } });
 await expect(transport.identify()).rejects.toBe(failure);
 expect(calls).toBe(0);
 unavailable = false;
 await expect(transport.identify()).resolves.toEqual({ id: '1', username: '1' });
 expect(calls).toBe(1); mock!.assertNoPendingInterceptors();
});

it.each(['transient', 'rate_limited', 'blocked', 'auth', 'gone'] as const)('preserves structured %s resolver failures before injected wire calls', async kind => {
 let calls = 0;
 const failure = new ChatTransportError({ kind, retryAfterMs: 123 });
 const transport = discordTransport({ token: async () => { throw failure; }, request: async () => { calls++; return {}; } });
 await expect(transport.identify()).rejects.toBe(failure);
 expect(calls).toBe(0);
});

it.each(['unknown', 'invalid', 'rotated'] as const)('sanitizes %s credentials and blocks POST at the last resolver boundary', async mode => {
 const pool = wire(); let posts = 0, resolves = 0;
 pool.intercept({ method: 'GET', path: '/api/v10/channels/10' }).reply(200, { id: '10', type: 1, recipients: [{ id: '2' }] });
 pool.intercept({ method: 'POST', path: '/api/v10/channels/10/messages' }).reply(() => { posts++; return { statusCode: 200, data: { id: '100', channel_id: '10' } }; });
 const transport = discordTransport({ token: async () => {
  if (++resolves === 1) return token;
  if (mode === 'unknown') throw new Error('resolver-secret-must-not-leak');
  return mode === 'invalid' ? 'credential-secret-must-not-leak' : `${'d'.repeat(24)}.${'e'.repeat(6)}.${'f'.repeat(27)}`;
 } });
 const kind = mode === 'unknown' ? 'blocked' : 'auth';
 const error = await transport.send('discord:dm:10', { text: 'hello' }).catch(error => error);
 expect(error).toBeInstanceOf(ChatTransportError);
 expect(error).toMatchObject({ message: `Chat transport: ${kind}`, failure: { kind } });
 expect(error.cause).toBeUndefined(); expect(String(error)).not.toContain('secret');
 expect(resolves).toBe(2); expect(posts).toBe(0);
 expect(mock!.pendingInterceptors()).toHaveLength(1);
});
