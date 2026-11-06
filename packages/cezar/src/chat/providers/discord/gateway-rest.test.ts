import { afterEach, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { discordTransport } from './index.ts';
import { ChatTransportError, type ChatEvent } from '../../provider.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const message = { id: '100', channel_id: '10', author: { id: '2', username: 'User' }, content: '/tasks', timestamp: new Date().toISOString() };
const button = { id: '200', application_id: '1', type: 3, token: 'fixture-token', channel_id: '10', user: message.author, data: { custom_id: 'action', component_type: 2 }, message: { id: '100', channel_id: '10', author: { id: '1', username: 'Bot', bot: true } } };

async function fixture(heartbeatAck = true, resolver?: () => Promise<string>, waitForReady = true) {
 const previous = getGlobalDispatcher(), mock = new MockAgent();
 mock.disableNetConnect(); setGlobalDispatcher(mock);
 cleanup.push(async () => { setGlobalDispatcher(previous); await mock.close(); });
 const pool = mock.get('https://discord.com');
 pool.intercept({ method: 'GET', path: '/api/v10/users/@me' }).reply(200, { id: '1', username: 'Bot', bot: true });
 pool.intercept({ method: 'GET', path: '/api/v10/gateway/bot' }).reply(200, { url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { remaining: 10 } });
 pool.intercept({ method: 'GET', path: '/api/v10/channels/10' }).reply(200, { id: '10', type: 1, recipients: [{ id: '2' }] }).persist();
 const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
 cleanup.push(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
 const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
 let current!: WebSocket, sockets = 0, credentials = true;
 const frames: Array<{ op: number; d: unknown }> = [], accepted: ChatEvent[] = [], states: string[] = [];
 server.on('connection', ws => {
  current = ws; sockets++;
  ws.on('message', raw => {
   const frame = JSON.parse(raw.toString()); frames.push(frame);
   if (frame.op === 1 && heartbeatAck) ws.send(JSON.stringify({ op: 11 }));
   if (frame.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session', resume_gateway_url: 'wss://gateway.discord.gg', user: { id: '1', username: 'Bot', bot: true } } }));
   if (frame.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 4, d: {} }));
  });
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 100 } }));
 });
 const transport = discordTransport({ token: resolver ?? fixtureToken, socket: () => new WebSocket(`ws://127.0.0.1:${address.port}`) });
 // Discord deduplicates Gateway sequences; it must not use the polling journal.
 const unexpectedJournalCall = (): never => { throw Error('Unexpected polling journal call'); };
 const journal = { recover: unexpectedJournalCall, assertReady: unexpectedJournalCall, prepareReceive: unexpectedJournalCall, snapshot: unexpectedJournalCall, duplicate: unexpectedJournalCall, finish: unexpectedJournalCall, touch: unexpectedJournalCall, flush: unexpectedJournalCall };
 const connection = transport.connect(journal, { needed: () => true, assertCredentials: async () => { if (!credentials) throw Error('ownership lost'); }, onHealth(health) { states.push(health.state); }, process: async () => {}, accept: async event => { accepted.push(event); } });
 cleanup.push(() => connection.stop()); connection.start(); if (waitForReady) await expect.poll(() => connection.health().state).toBe('polling');
 return { pool, mock, connection, accepted, frames, states, sockets: () => sockets, revoke: () => { credentials = false; }, send: (t: string, s: number, d: unknown) => current.send(JSON.stringify({ op: 0, t, s, d })) };
}

it.each([403, 404, 500])('drops inaccessible channel input (%i) and accepts the next healthy message', async status => {
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(status, { message: 'Unavailable' });
 x.send('MESSAGE_CREATE', 2, message); await expect.poll(() => x.accepted.length).toBe(1);
 x.send('MESSAGE_CREATE', 3, { ...message, id: '101', channel_id: '30', guild_id: '20', content: '<@1> /tasks' });
 x.send('MESSAGE_CREATE', 4, { ...message, id: '102' });
 await expect.poll(() => x.accepted.map(e => e.id)).toEqual(['message:100', 'message:102']);
 expect(x.connection.health().state).toBe('polling'); expect(x.sockets()).toBe(1); x.mock.assertNoPendingInterceptors();
});

it.each([400, 403, 500])('drops a failed/ambiguous callback (%i) without retry or button admission', async status => {
 const x = await fixture(); let callbacks = 0;
 x.pool.intercept({ method: 'POST', path: '/api/v10/interactions/200/fixture-token/callback' }).reply(() => { callbacks++; return { statusCode: status, data: { message: 'Failed callback' } }; }).persist();
 x.send('MESSAGE_CREATE', 2, message); await expect.poll(() => x.accepted.length).toBe(1);
 x.send('INTERACTION_CREATE', 3, button); x.send('MESSAGE_CREATE', 4, { ...message, id: '102' });
 await expect.poll(() => x.accepted.map(e => e.id)).toEqual(['message:100', 'message:102']);
 await expect.poll(() => x.frames.filter(f => f.op === 1).length).toBeGreaterThanOrEqual(2);
 expect(callbacks).toBe(1); expect(x.connection.health().state).toBe('polling'); expect(x.sockets()).toBe(1);
});

it.each(['metadata', 'callback'])('keeps %s HTTP 401 fatal', async kind => {
 const x = await fixture();
 x.pool.intercept({ method: kind === 'metadata' ? 'GET' : 'POST', path: kind === 'metadata' ? '/api/v10/channels/30' : '/api/v10/interactions/200/fixture-token/callback' }).reply(401, { message: 'Unauthorized' });
 x.send(kind === 'metadata' ? 'MESSAGE_CREATE' : 'INTERACTION_CREATE', 2, kind === 'metadata' ? { ...message, channel_id: '30' } : button);
 await expect.poll(() => x.connection.health().state).toBe('credentials-unavailable');
 expect(x.accepted).toHaveLength(0); expect(x.sockets()).toBe(1);
});

it('keeps ownership failure during a failed REST request fatal', async () => {
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(() => { x.revoke(); return { statusCode: 403, data: {} }; });
 x.send('MESSAGE_CREATE', 2, { ...message, channel_id: '30' });
 await expect.poll(() => x.connection.health().state).toBe('blocked'); expect(x.accepted).toHaveLength(0);
});

it('still reconnects and resumes after a missing heartbeat ACK', async () => {
 const x = await fixture(false);
 await expect.poll(() => x.frames.find(f => f.op === 6), { timeout: 8000 }).toMatchObject({ d: { session_id: 'session', seq: 1 } });
 expect(x.sockets()).toBe(2);
}, 10000);

const fixtureToken = `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`;
it('recovers Gateway discovery after a transient credential resolver outage without wire effects', async () => {
 let unavailable = true;
 const x = await fixture(true, async () => { if (unavailable) throw new ChatTransportError({ kind: 'transient', retryAfterMs: 100 }); return fixtureToken; }, false);
 await expect.poll(() => x.connection.health().state).toBe('backoff');
 expect(x.sockets()).toBe(0); expect(x.frames).toEqual([]);
 expect(x.mock.pendingInterceptors().filter(i => i.path === '/api/v10/users/@me')).toHaveLength(1);
 unavailable = false;
 await expect.poll(() => x.connection.health().state).toBe('polling');
 x.send('MESSAGE_CREATE', 2, message);
 await expect.poll(() => x.accepted.length).toBe(1);
 expect(x.sockets()).toBe(1);
});

it('resumes an established Gateway after a transient resolver outage', async () => {
 let unavailable = false;
 const x = await fixture(true, async () => { if (unavailable) throw new ChatTransportError({ kind: 'transient' }); return fixtureToken; });
 unavailable = true;
 const before = x.frames.length;
 await expect.poll(() => x.connection.health().state).toBe('backoff');
 expect(x.frames).toHaveLength(before); expect(x.accepted).toEqual([]);
 unavailable = false;
 await expect.poll(() => x.frames.find(f => f.op === 6), { timeout: 8000 }).toMatchObject({ d: { session_id: 'session', seq: 1 } });
 await expect.poll(() => x.connection.health().state).toBe('polling');
 x.send('MESSAGE_CREATE', 5, message);
 await expect.poll(() => x.accepted.length).toBe(1);
 expect(x.sockets()).toBe(2);
}, 10000);

it('keeps a rotated resolver token fatal to the Gateway without sending it', async () => {
 let token = fixtureToken;
 const x = await fixture(true, async () => token);
 const before = x.frames.length;
 token = `${'d'.repeat(24)}.${'e'.repeat(6)}.${'f'.repeat(27)}`;
 x.send('MESSAGE_CREATE', 2, message);
 await expect.poll(() => x.connection.health().state).toBe('credentials-unavailable');
 expect(x.frames).toHaveLength(before); expect(x.accepted).toEqual([]); expect(x.sockets()).toBe(1);
});

it('retries input whose lookup hits a route rate limit instead of dropping it', async () => {
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(429, { retry_after: 0.2 }, { headers: { 'x-ratelimit-scope': 'user' } });
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(200, { id: '30', type: 0, guild_id: '20' });
 x.send('MESSAGE_CREATE', 2, { ...message, id: '101', channel_id: '30', guild_id: '20', content: '<@1> /tasks' });
 x.send('MESSAGE_CREATE', 3, { ...message, id: '102' });
 // The held event is parked off the serial queue, so later input is not stalled behind it.
 await expect.poll(() => x.accepted.map(e => e.id)).toEqual(['message:102', 'message:101']);
 expect(x.connection.health().state).toBe('polling'); expect(x.sockets()).toBe(1); x.mock.assertNoPendingInterceptors();
});

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const mention = { ...message, id: '101', channel_id: '30', guild_id: '20', content: '<@1> /tasks' };
it('keeps input flowing while one lookup is held on a rate limit', async () => {
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(429, { retry_after: 4.5 });
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(200, { id: '30', type: 0, guild_id: '20' });
 x.send('MESSAGE_CREATE', 2, mention);
 for (let i = 0; i < 105; i++) { x.send('MESSAGE_CREATE', 3 + i, { ...message, id: String(1000 + i) }); await pause(30); }
 await expect.poll(() => x.accepted.length, { timeout: 8000 }).toBe(106);
 expect(x.accepted.at(-1)?.id).toBe('message:101');
 expect(x.connection.health().state).toBe('polling'); expect(x.sockets()).toBe(1); x.mock.assertNoPendingInterceptors();
}, 15000);

it('holds a lookup past five seconds and admits it without reconnecting', async () => {
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(429, { retry_after: 5.5 });
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(200, { id: '30', type: 0, guild_id: '20' });
 x.send('MESSAGE_CREATE', 2, mention); x.send('MESSAGE_CREATE', 3, { ...message, id: '102' });
 await expect.poll(() => x.accepted.map(e => e.id), { timeout: 9000 }).toEqual(['message:102', 'message:101']);
 expect(x.states).not.toContain('backoff'); expect(x.sockets()).toBe(1); expect(x.frames.some(f => f.op === 6)).toBe(false);
}, 12000);

it('drops only the event limited past the hold budget and keeps the session', async () => {
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(429, { retry_after: 120 });
 x.send('MESSAGE_CREATE', 2, mention); x.send('MESSAGE_CREATE', 3, { ...message, id: '102' });
 await expect.poll(() => x.accepted.map(e => e.id)).toEqual(['message:102']);
 await pause(300);
 expect(x.states).not.toContain('backoff'); expect(x.connection.health().state).toBe('polling'); expect(x.sockets()).toBe(1);
 await x.connection.stop(); expect(x.accepted.map(e => e.id)).toEqual(['message:102']);
});

it('does not hold a button acknowledgement past its deadline', async () => {
 const x = await fixture(); let callbacks = 0;
 x.pool.intercept({ method: 'POST', path: '/api/v10/interactions/200/fixture-token/callback' }).reply(() => { callbacks++; return { statusCode: 429, data: { retry_after: 3 } }; });
 x.send('INTERACTION_CREATE', 2, button); x.send('MESSAGE_CREATE', 3, message);
 await expect.poll(() => x.accepted.map(e => e.id), { timeout: 1500 }).toEqual(['message:100']);
 expect(callbacks).toBe(1); expect(x.connection.health().state).toBe('polling');
});

it('retries a briefly limited button acknowledgement within its deadline', async () => {
 const x = await fixture();
 x.pool.intercept({ method: 'POST', path: '/api/v10/interactions/200/fixture-token/callback' }).reply(429, { retry_after: 0.3 });
 x.pool.intercept({ method: 'POST', path: '/api/v10/interactions/200/fixture-token/callback' }).reply(204, '');
 x.send('INTERACTION_CREATE', 2, button);
 await expect.poll(() => x.accepted.map(e => e.id)).toEqual(['interaction:200']);
 x.mock.assertNoPendingInterceptors();
});

const dm = (id: string) => ({ id, type: 1, recipients: [{ id: '2' }] });
const tap = { ...button, channel_id: '40', message: { ...button.message, channel_id: '40' } };
it('keeps a held button ahead of later input in its chat while other chats flow', async () => {
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/40' }).reply(200, dm('40'));
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/40' }).reply(429, { retry_after: 1 });
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/40' }).reply(200, dm('40'));
 x.pool.intercept({ method: 'POST', path: '/api/v10/interactions/200/fixture-token/callback' }).reply(204, '');
 x.send('MESSAGE_CREATE', 2, { ...message, id: '300', channel_id: '40' });
 await expect.poll(() => x.accepted.length).toBe(1);
 x.send('INTERACTION_CREATE', 3, tap); await pause(100);
 x.send('MESSAGE_CREATE', 4, { ...message, id: '301', channel_id: '40', content: 'follow-up' });
 x.send('MESSAGE_CREATE', 5, { ...message, id: '102' });
 await expect.poll(() => x.accepted.map(e => e.id), { timeout: 4000 }).toEqual(['message:300', 'message:102', 'interaction:200', 'message:301']);
 expect(x.connection.health().state).toBe('polling'); expect(x.sockets()).toBe(1); x.mock.assertNoPendingInterceptors();
}, 8000);

it('does not stall other chats behind a slow button acknowledgement', async () => {
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/40' }).reply(200, dm('40')).persist();
 x.pool.intercept({ method: 'POST', path: '/api/v10/interactions/200/fixture-token/callback' }).reply(204, '').delay(2400);
 x.send('INTERACTION_CREATE', 2, tap); x.send('MESSAGE_CREATE', 3, { ...message, id: '301', channel_id: '40' });
 for (let i = 0; i < 105; i++) { x.send('MESSAGE_CREATE', 4 + i, { ...message, id: String(1000 + i) }); await pause(15); }
 await expect.poll(() => x.accepted.length, { timeout: 5000 }).toBe(107);
 // Acknowledged before it is processed, and still ahead of later input from its own chat.
 expect(x.accepted.slice(-2).map(e => e.id)).toEqual(['interaction:200', 'message:301']);
 expect(x.connection.health().state).toBe('polling'); expect(x.sockets()).toBe(1);
}, 10000);

it('stops promptly with input parked behind a held event, accepting none of it', async () => {
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(429, { retry_after: 30 });
 x.send('MESSAGE_CREATE', 2, mention); x.send('MESSAGE_CREATE', 3, { ...mention, id: '103' }); x.send('MESSAGE_CREATE', 4, { ...message, id: '102' });
 await expect.poll(() => x.accepted.map(e => e.id)).toEqual(['message:102']);
 const started = Date.now(); await x.connection.stop();
 expect(Date.now() - started).toBeLessThan(1000); expect(x.accepted.map(e => e.id)).toEqual(['message:102']);
});

// Review 936b5295: lifecycle events and ignored chatter must not compete for the hold cap.
const inGuild = (id: string, content = '<@1> /tasks') => ({ ...message, id, channel_id: '30', guild_id: '20', content });
const held = (x: Awaited<ReturnType<typeof fixture>>, seconds: number) => {
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(429, { retry_after: seconds });
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(200, { id: '30', type: 0, guild_id: '20' }).persist();
};
it('emits a channel removal queued behind a full hold cap, after its chat, and reports the drop', async () => {
 const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); cleanup.push(async () => { warn.mockRestore(); });
 const x = await fixture(); held(x, 1.5);
 x.send('GUILD_CREATE', 2, { id: '20', channels: [{ id: '30', type: 0 }] }); await pause(100);
 x.send('MESSAGE_CREATE', 3, inGuild('500')); await pause(200);
 for (let i = 0; i < 100; i++) x.send('MESSAGE_CREATE', 4 + i, inGuild(String(600 + i)));
 await pause(300);
 x.send('CHANNEL_DELETE', 200, { id: '30', guild_id: '20', type: 0 }); x.send('MESSAGE_CREATE', 201, { ...message, id: '102' });
 await expect.poll(() => x.accepted.at(-1)?.kind, { timeout: 5000 }).toBe('membership');
 const ids = x.accepted.map(e => e.id);
 expect(ids[0]).toBe('message:102'); expect(ids.at(-1)).toBe('removed:30:30:200');
 expect(ids.filter(id => id.startsWith('message:'))).toHaveLength(101); // 500 + 99 followers; the 100th follower hit the cap
 expect(warn).toHaveBeenCalledTimes(1);
 const line = String(warn.mock.calls[0]![0]);
 expect(line).toContain('1 guild over the 100-event hold cap'); expect(line).not.toMatch(/\b(30|20|699)\b/);
 expect(x.connection.health().state).toBe('polling'); expect(x.sockets()).toBe(1);
}, 10000);

it('does not park chatter the core ignores behind a held event', async () => {
 const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); cleanup.push(async () => { warn.mockRestore(); });
 const x = await fixture(); held(x, 1);
 x.send('MESSAGE_CREATE', 2, inGuild('500')); await pause(200);
 for (let i = 0; i < 120; i++) { x.send('MESSAGE_CREATE', 3 + i, inGuild(String(600 + i), `chatter ${i}`)); if (i % 40 === 39) await pause(50); }
 x.send('MESSAGE_CREATE', 200, inGuild('700'));
 await expect.poll(() => x.accepted.map(e => e.id), { timeout: 4000 }).toEqual(['message:500', 'message:700']);
 expect(warn).not.toHaveBeenCalled(); expect(x.connection.health().state).toBe('polling');
}, 8000);

it('reports an event dropped past the hold budget once, without identifiers', async () => {
 const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); cleanup.push(async () => { warn.mockRestore(); });
 const x = await fixture();
 x.pool.intercept({ method: 'GET', path: '/api/v10/channels/30' }).reply(429, { retry_after: 120 });
 x.send('MESSAGE_CREATE', 2, mention); x.send('MESSAGE_CREATE', 3, { ...message, id: '102' });
 await expect.poll(() => warn.mock.calls.length).toBe(1);
 expect(String(warn.mock.calls[0]![0])).toBe('Discord dropped held chat input (1 guild over the 60 s hold budget); Gateway resume cannot replay it.');
 expect(x.accepted.map(e => e.id)).toEqual(['message:102']);
});
