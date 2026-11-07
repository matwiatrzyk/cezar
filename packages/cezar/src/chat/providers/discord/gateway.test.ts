import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { discordGateway, DISCORD_INTENTS } from './gateway.ts';
import { ChatTransportError, type ChatEvent } from '../../provider.ts';
import type { DiscordRequest } from './rest.ts';
import { drive, elapse, eventually, fakeClock, realClock } from '../../test-support/fake-clock.testkit.ts';
const cleanup: Array<() => Promise<void>> = [];
// Backoffs (5 s), the identify budget (60 s) and the 10 s lookup timeout run on the fake clock.
beforeEach(fakeClock);
afterEach(async () => { realClock(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(reconnectHelloDelayMs = 0, starts: Array<{ remaining: number; reset_after?: number }> = [{ remaining: 10 }], nativeCommands?: { tasks(query: string, chatId: string, userId: string): Promise<readonly { name: string; value: string }[]> }) {
 const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
 cleanup.push(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); });
 const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
 const received: ChatEvent[] = [], calls: Array<{ path: string; body: unknown }> = [], frames: Array<{ op: number; d: unknown }> = [];
 const urls: string[] = [];
 let current!: WebSocket, valid = true, sockets = 0;
 const request: DiscordRequest = async (_method, path, body, signal) => {
  calls.push({ path, body });
  if (path === '/users/@me') return { id: '1', username: 'Bot', bot: true };
  if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: starts.length > 1 ? starts.shift() : starts[0] };
  if (path === '/channels/10') return { id: '10', type: 1, recipients: [{ id: '2' }] };
  if (path === '/channels/30') return { id: '30', type: 0, guild_id: '20' };
  // A lookup that never answers unless its signal aborts.
  if (path === '/channels/50') return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new ChatTransportError({ kind: 'transient' }))));
  return {};
 };
 server.on('connection', ws => { current = ws; sockets++; ws.on('message', raw => { const frame = JSON.parse(raw.toString()); frames.push(frame); if (frame.op === 1) ws.send(JSON.stringify({ op: 11 })); if (frame.op === 2) ws.send(JSON.stringify({ op: 0, t: 'READY', s: 1, d: { session_id: 'session', resume_gateway_url: 'wss://gateway-us-east1-b.discord.gg', user: { id: '1', username: 'Bot', bot: true } } })); if (frame.op === 6) ws.send(JSON.stringify({ op: 0, t: 'RESUMED', s: 5, d: {} })); }); const hello = () => ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 200 } })); if (sockets > 1 && reconnectHelloDelayMs) { const timer = setTimeout(hello, reconnectHelloDelayMs); cleanup.push(async () => { clearTimeout(timer); }); } else hello(); });
 const connection = discordGateway({ token: 'simulated-only', request, valid: () => valid, socket: url => { urls.push(url); return new WebSocket(`ws://127.0.0.1:${address.port}`); }, options: { needed: () => true, assertCredentials: async () => { if (!valid) throw Error('rotated'); }, onHealth() {}, process: async () => {}, accept: async event => { received.push(event); }, ...(nativeCommands ? { nativeCommands } : {}) } });
 cleanup.push(() => connection.stop()); connection.start(); await eventually(() => expect(connection.health().state).toBe('polling'));
 return { connection, received, frames, calls, urls, rotate: () => { valid = false; }, sockets: () => sockets, send: (t: string, s: number, d: unknown) => current.send(JSON.stringify({ op: 0, t, s, d })), close: (code: number) => current.close(code), reconnect: () => current.send(JSON.stringify({ op: 7, d: null })), invalidate: () => current.send(JSON.stringify({ op: 9, d: false })) };
}
const message = { id: '100', channel_id: '10', author: { id: '2', username: 'Person' }, timestamp: new Date().toISOString(), content: '/tasks' };
describe('Discord Gateway simulated wire', () => {
 it('registers native /tasks once and executes a selected task through ChatEvent semantics', async () => {
  const x = await fixture(0, [{ remaining: 10 }], { tasks: async query => [{ name: `Task ${query}`, value: 'task-id' }] });
  expect(x.calls.find(call => call.path === '/applications/1/commands')?.body).toMatchObject([{ name: 'tasks', options: [{ autocomplete: true }] }]);
  const command = { id: '210', type: 2, token: 'interaction-command', application_id: '1', channel_id: '10', user: { id: '2', username: 'Person' }, data: { name: 'tasks', options: [{ name: 'task', type: 3, value: 'task-id' }] } };
  x.send('INTERACTION_CREATE', 2, command); await eventually(() => expect(x.received.length).toBe(1));
  expect(x.received[0]).toMatchObject({ kind: 'message', text: '/status task-id', messageId: '210', chat: { id: 'discord:dm:10' } });
  expect(x.calls.find(call => call.path.endsWith('/callback'))?.body).toMatchObject({ type: 5 });
  await eventually(() => expect(x.calls.some(call => call.path.endsWith('/messages/@original'))).toBe(true));
 });

 it('answers Discord autocomplete with bounded choices', async () => {
  const x = await fixture(0, [{ remaining: 10 }], { tasks: async query => [{ name: query, value: 'task-id' }] });
  const autocomplete = { id: '211', type: 4, token: 'interaction-autocomplete', application_id: '1', channel_id: '10', user: { id: '2', username: 'Person' }, data: { name: 'tasks', options: [{ name: 'task', type: 3, value: 'tas', focused: true }] } };
  x.send('INTERACTION_CREATE', 2, autocomplete); await eventually(() => expect(x.calls.some(call => call.path.endsWith('/callback'))).toBe(true));
  expect(x.calls.find(call => call.path.endsWith('/callback'))?.body).toEqual({ type: 8, data: { choices: [{ name: 'tas', value: 'task-id' }] } });
  expect(x.received).toHaveLength(0);
 });

 it('ignores autocomplete for another command or option', async () => {
  let requests = 0;
  const x = await fixture(0, [{ remaining: 10 }], { tasks: async () => { requests++; return []; } });
  const event = { id: '212', type: 4, token: 'interaction-autocomplete', application_id: '1', channel_id: '10', user: { id: '2', username: 'Person' }, data: { name: 'other', options: [{ name: 'task', type: 3, value: 'tas', focused: true }] } };
  x.send('INTERACTION_CREATE', 2, event);
  x.send('INTERACTION_CREATE', 3, { ...event, id: '213', data: { name: 'tasks', options: [{ name: 'other', type: 3, value: 'tas', focused: true }] } });
  x.send('MESSAGE_CREATE', 4, message);
  await eventually(() => expect(x.received.length).toBe(1));
  expect(requests).toBe(0);
 });

 it('identifies with intents, heartbeats, normalizes and suppresses replay by sequence', async () => {
  const x = await fixture(); expect(x.frames.find(frame => frame.op === 2)?.d).toMatchObject({ intents: DISCORD_INTENTS });
  x.send('MESSAGE_CREATE', 2, message); x.send('MESSAGE_CREATE', 2, message);
  await eventually(() => expect(x.received.length).toBe(1)); expect(x.received[0]).toMatchObject({ kind: 'message', chat: { id: 'discord:dm:10', kind: 'private' } });
  await eventually(() => expect(x.frames.filter(frame => frame.op === 1).length).toBeGreaterThanOrEqual(2));
  expect(x.connection.health().state).toBe('polling');
  await x.connection.stop(); const before = x.calls.length; expect(x.connection.health().state).toBe('stopped'); expect(x.calls.length).toBe(before);
 });
 it('acknowledges Gateway buttons through outbound callbacks and rejects cross-channel receipts', async () => {
  const x = await fixture(); const button = { id: '200', type: 3, token: 'interaction-secret', application_id: '1', channel_id: '10', user: { id: '2', username: 'Person' }, data: { custom_id: 'action', component_type: 2 }, message: { id: '100', channel_id: '10', author: { id: '1', username: 'Bot', bot: true } } };
  x.send('INTERACTION_CREATE', 2, button); await eventually(() => expect(x.received.length).toBe(1));
  expect(x.calls.find(call => call.path.endsWith('/callback'))?.body).toEqual({ type: 6 });
  x.send('INTERACTION_CREATE', 3, { ...button, message: { ...button.message, channel_id: '99' } });
  x.send('MESSAGE_CREATE', 4, { ...message, id: '101' }); await eventually(() => expect(x.received.length).toBe(2));
  expect(x.calls.filter(call => call.path.endsWith('/callback'))).toHaveLength(1);
 });
 it('resumes and does not replay a sequence older than the core bounded ledger', async () => {
  const x = await fixture(250); x.send('MESSAGE_CREATE', 2, message); await eventually(() => expect(x.received.length).toBe(1));
  // The reconnect waits out the 5 s backoff before it dials the resume URL.
  x.reconnect(); await elapse(4900); expect(x.sockets()).toBe(1);
  await eventually(() => expect(x.sockets()).toBe(2), 1);
  expect(x.urls[1]).toContain('gateway-us-east1-b.discord.gg');
  // A connected socket does not mean Hello/Resume have crossed the wire yet.
  await eventually(() => expect(x.frames.find(frame => frame.op === 6)?.d).toMatchObject({ session_id: 'session', seq: 2 }));
  await eventually(() => expect(x.connection.health().state).toBe('polling'));
  x.send('MESSAGE_CREATE', 2, message); x.send('MESSAGE_CREATE', 6, { ...message, id: '102' }); await eventually(() => expect(x.received.length).toBe(2));
 });
 it('fences receive effects after rotation', async () => {
  const x = await fixture(); x.rotate(); x.send('MESSAGE_CREATE', 2, message);
  await eventually(() => expect(x.connection.health().state).toBe('blocked')); expect(x.received).toHaveLength(0);
 });
 it('does not confuse unavailable guilds with removal and emits removal for known channels', async () => {
  const x = await fixture();
  x.send('GUILD_CREATE', 2, { id: '20', channels: [{ id: '30', type: 0 }] });
  x.send('GUILD_DELETE', 3, { id: '20', unavailable: true });
  x.send('MESSAGE_CREATE', 4, message); await eventually(() => expect(x.received.length).toBe(1));
  x.send('GUILD_DELETE', 5, { id: '20' }); await eventually(() => expect(x.received.length).toBe(2));
  expect(x.received[1]).toMatchObject({ kind: 'membership', reason: 'removed', chat: { id: 'discord:guild:20:30', kind: 'group' } });
 });
 it('stops reconnecting on disallowed intents', async () => {
  const x = await fixture(); x.close(4014); await eventually(() => expect(x.connection.health().state).toBe('blocked')); expect(x.sockets()).toBe(1);
 });

 it('looks a channel up once and skips unaddressed guild chatter', async () => {
  const x = await fixture(), lookups = (id: string) => x.calls.filter(call => call.path === `/channels/${id}`).length;
  const guild = { ...message, channel_id: '30', guild_id: '20' };
  x.send('MESSAGE_CREATE', 2, message); x.send('MESSAGE_CREATE', 3, { ...message, id: '101' }); x.send('MESSAGE_CREATE', 4, { ...message, id: '102' });
  x.send('MESSAGE_CREATE', 5, { ...guild, id: '103', content: 'chatter' });
  x.send('MESSAGE_CREATE', 6, { ...guild, id: '104', content: '<@1> /tasks' }); x.send('MESSAGE_CREATE', 7, { ...guild, id: '105', content: '<@1> /tasks' });
  await eventually(() => expect(x.received.map(event => event.id)).toEqual(['message:100', 'message:101', 'message:102', 'message:104', 'message:105']));
  expect(lookups('10')).toBe(1); expect(lookups('30')).toBe(1);
  x.send('CHANNEL_UPDATE', 8, { id: '30', type: 0, guild_id: '20' }); x.send('MESSAGE_CREATE', 9, { ...guild, id: '106', content: '<@1> /tasks' });
  await eventually(() => expect(x.received.length).toBe(6)); expect(lookups('30')).toBe(2);
 });
 it('refreshes the session start budget instead of blocking after it is spent', async () => {
  const x = await fixture(0, [{ remaining: 1, reset_after: 50 }, { remaining: 5, reset_after: 50 }]);
  x.invalidate();
  await eventually(() => expect(x.frames.filter(frame => frame.op === 2).length).toBe(2), 8);
  await eventually(() => expect(x.connection.health().state).toBe('polling'));
  expect(x.calls.filter(call => call.path === '/gateway/bot').length).toBeGreaterThanOrEqual(2);
 });
 it('waits a sane default when Discord omits the session start reset', async () => {
  const x = await fixture(0, [{ remaining: 1 }]);
  x.invalidate();
  // The spent budget refills a minute after discovery: nothing is identified or refreshed before that…
  await elapse(59_000, 100);
  expect(x.calls.filter(call => call.path === '/gateway/bot')).toHaveLength(1);
  expect(x.frames.filter(frame => frame.op === 2)).toHaveLength(1); expect(x.connection.health().state).toBe('backoff');
  // …and then the budget is refreshed and the session identifies again.
  await eventually(() => expect(x.frames.filter(frame => frame.op === 2)).toHaveLength(2), 2);
  expect(x.calls.filter(call => call.path === '/gateway/bot')).toHaveLength(2);
 });
 it('aborts a hung channel lookup on stop', async () => {
  const x = await fixture(); x.send('MESSAGE_CREATE', 2, { ...message, channel_id: '50' });
  await eventually(() => expect(x.calls.some(call => call.path === '/channels/50')).toBe(true));
  // Settles within a fake second: it must not sit out the 10 s lookup timeout.
  await drive(x.connection.stop(), 999); expect(x.received).toHaveLength(0);
 });
 it('drops a hung channel lookup after the REST timeout and keeps input flowing', async () => {
  const x = await fixture(); x.send('MESSAGE_CREATE', 2, { ...message, channel_id: '50' }); x.send('MESSAGE_CREATE', 3, { ...message, id: '101' });
  // The serial queue waits out the lookup's 10 s timeout, then drops it and moves on.
  await elapse(9900, 100); expect(x.received).toHaveLength(0);
  await eventually(() => expect(x.received.map(event => event.id)).toEqual(['message:101']), 1);
  expect(x.connection.health().state).toBe('polling'); expect(x.sockets()).toBe(1);
 });
});
