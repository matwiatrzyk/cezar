import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { slackTransport } from './transport.ts';
import { createSlackWire, slackError, type SlackMethod, type SlackWire } from './client.ts';
import { encodeSlackCredentials } from './identity.ts';
import type { ChatConnectionOptions, ReceiveJournal } from '../../connection.ts';
import type { ChatEvent } from '../../provider.ts';

const token = encodeSlackCredentials({ appToken: 'xapp-test-app-token', botToken: 'xoxb-test-bot-token' });
const now = 1800000000000;
afterEach(() => { vi.restoreAllMocks(); });

describe('Slack Web API request shape', () => {
 const form = 'application/x-www-form-urlencoded';
 it.each<[SlackMethod, Record<string, unknown>, string, string, string]>([
  ['auth.test', {}, form, '', 'xoxb'],
  ['conversations.info', { channel: 'C1' }, form, 'channel=C1', 'xoxb'],
  ['conversations.members', { channel: 'C1', limit: 200, cursor: 'dXNlcjpVMDYx' }, form, 'channel=C1&limit=200&cursor=dXNlcjpVMDYx', 'xoxb'],
  ['conversations.history', { channel: 'C1', latest: '1800000000.000001', inclusive: true, limit: 1 }, form, 'channel=C1&latest=1800000000.000001&inclusive=true&limit=1', 'xoxb'],
  ['conversations.replies', { channel: 'C1', ts: '1800000000.000001', latest: '1800000000.000001', inclusive: true, limit: 1 }, form, 'channel=C1&ts=1800000000.000001&latest=1800000000.000001&inclusive=true&limit=1', 'xoxb'],
  ['chat.postMessage', { channel: 'C1', text: 'a&b', blocks: [{ type: 'section' }] }, 'application/json; charset=utf-8', '{"channel":"C1","text":"a&b","blocks":[{"type":"section"}]}', 'xoxb'],
  ['chat.update', { channel: 'C1', ts: '1800000000.000001', text: 'x', blocks: [] }, 'application/json; charset=utf-8', '{"channel":"C1","ts":"1800000000.000001","text":"x","blocks":[]}', 'xoxb'],
  ['apps.connections.open', {}, 'application/json', '{}', 'xapp'],
 ])('%s is sent as %s', async (method, body, type, encoded, prefix) => {
  const requests: Array<[string, RequestInit]> = [];
  const client = createSlackWire(async () => token, { fetch: async (url, init) => { requests.push([String(url), init!]); return new Response('{"ok":true}'); } });
  await client.call(method, body);
  const [url, init] = requests[0]!;
  expect(url).toBe(`https://slack.com/api/${method}`);
  expect(init.method).toBe('POST');
  expect(init.headers).toEqual({ Authorization: `Bearer ${prefix}-test-${prefix === 'xapp' ? 'app' : 'bot'}-token`, 'Content-Type': type });
  expect(init.body).toBe(encoded);
  expect(String(init.body)).not.toContain('xox');
 });
});

class Socket extends EventEmitter { readyState = 1; sent: string[] = []; send(data: string) { this.sent.push(data); } terminate() { this.emit('close'); } ping() {} }
const payload = (event: Record<string, unknown>, id = 'Ev1') => ({ team_id: 'T1', event_id: id, authorizations: [{ user_id: 'U1', is_bot: true }], event });
const message = (n: number, extra: Record<string, unknown> = {}) => ({ type: 'message', user: 'U2', channel: 'C1', channel_type: 'channel', ts: `1800000000.${String(n).padStart(6, '0')}`, text: 'chatter', ...extra });
function harness(info: (channel: string) => unknown) {
 const socket = new Socket(), events: ChatEvent[] = [], health: string[] = [], calls: string[] = [];
 const wire: SlackWire = {
  socket: () => socket as unknown as WebSocket,
  async call(method, body) {
   calls.push(method);
   if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' };
   if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/test' };
   if (method === 'conversations.info') return info(String(body.channel));
   throw new Error(`unexpected ${method}`);
  },
 };
 const options: ChatConnectionOptions = { needed: () => true, assertCredentials: async () => {}, onHealth: value => { health.push(value.state); }, process: async () => {}, accept: async event => { events.push(event); } };
 const transport = slackTransport(wire), connection = transport.connect({} as ReceiveJournal, options, () => now);
 let envelope = 0;
 const emit = (body: unknown, extra: Record<string, unknown> = {}) => socket.emit('message', Buffer.from(JSON.stringify({ type: 'events_api', envelope_id: `env-${++envelope}`, payload: body, ...extra })));
 const lookups = () => calls.filter(method => method === 'conversations.info').length;
 return { socket, events, health, calls, transport, connection, emit, lookups };
}
const member = (channel: string) => ({ channel: { id: channel, is_im: channel.startsWith('D'), is_member: true } });

describe('Slack inbound channel identity', () => {
 it('skips the lookup for unaddressed, unthreaded channel chatter but still serves DMs, mentions and threads', async () => {
  const h = harness(member);
  h.connection.start(); await vi.waitFor(() => expect(h.socket.listenerCount('message')).toBe(1));
  for (let n = 1; n <= 20; n++) h.emit(payload(message(n), `Ev${n}`));
  h.emit(payload(message(21, { text: '<@U1> cezar tasks' }), 'Ev21'));
  h.emit(payload(message(22, { thread_ts: '1799999999.000001' }), 'Ev22'));
  h.emit(payload(message(23, { channel: 'D1', channel_type: 'im', text: 'plain dm' }), 'Ev23'));
  h.emit(payload(message(24, { channel_type: undefined }), 'Ev24'));
  await vi.waitFor(() => expect(h.events).toHaveLength(4));
  expect(h.events.map(event => event.kind === 'message' && event.messageId)).toEqual(['1800000000.000021', '1800000000.000022', '1800000000.000023', '1800000000.000024']);
  expect(h.events[2]).toMatchObject({ chat: { id: 'private:T1:U1:D1', kind: 'private' }, addressed: true });
  // C1 is looked up once and cached; the DM once.
  expect(h.lookups()).toBe(2);
  await h.connection.stop();
 });

 it('caches identity with a TTL and drops it when the bot leaves the channel', async () => {
  let clock = now; vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const h = harness(member);
  h.connection.start(); await vi.waitFor(() => expect(h.socket.listenerCount('message')).toBe(1));
  h.emit(payload(message(1, { text: '<@U1> a' }), 'E1')); h.emit(payload(message(2, { text: '<@U1> b' }), 'E2'));
  await vi.waitFor(() => expect(h.events).toHaveLength(2)); expect(h.lookups()).toBe(1);
  clock += 10 * 60_000;
  h.emit(payload(message(3, { text: '<@U1> c' }), 'E3'));
  await vi.waitFor(() => expect(h.events).toHaveLength(3)); expect(h.lookups()).toBe(2);
  h.emit({ ...payload({ type: 'member_left_channel', user: 'U1', channel: 'C1' }, 'E4'), event_time: now / 1000 });
  await vi.waitFor(() => expect(h.events).toHaveLength(4));
  h.emit(payload(message(5, { text: '<@U1> d' }), 'E5'));
  await vi.waitFor(() => expect(h.events).toHaveLength(5)); expect(h.lookups()).toBe(3);
  await h.connection.stop();
 });

 it('never caches an ineligible channel, and a fresh membership check refreshes the cache', async () => {
  let joined = false;
  const h = harness(channel => ({ channel: { id: channel, is_im: false, is_member: joined } }));
  h.connection.start(); await vi.waitFor(() => expect(h.socket.listenerCount('message')).toBe(1));
  h.emit(payload(message(1, { text: '<@U1> a' }), 'E1'));
  await vi.waitFor(() => expect(h.lookups()).toBe(1)); joined = true;
  h.emit(payload(message(2, { text: '<@U1> b' }), 'E2'));
  await vi.waitFor(() => expect(h.events).toHaveLength(1)); expect(h.lookups()).toBe(2);
  joined = false;
  // The authorization path never trusts the cache.
  expect(await h.transport.isMember('group:T1:U1:C1', 'U2')).toBe(false); expect(h.lookups()).toBe(3);
  h.emit(payload(message(3, { text: '<@U1> c' }), 'E3'));
  await vi.waitFor(() => expect(h.lookups()).toBe(4)); expect(h.events).toHaveLength(1);
  await h.connection.stop();
 });

 it('drops one rate-limited event without tearing the socket down', async () => {
  let clock = now, limited = true; vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const h = harness(channel => { if (limited) throw slackError('ratelimited', 30_000); return member(channel); });
  h.connection.start(); await vi.waitFor(() => expect(h.socket.listenerCount('message')).toBe(1));
  h.emit(payload(message(1, { text: '<@U1> a' }), 'E1'));
  // Inside Slack's retry-after window no further lookups are spent.
  h.emit(payload(message(2, { channel: 'D1', channel_type: 'im' }), 'E2'));
  h.emit(payload(message(3, { text: '<@U1> b' }), 'E3'));
  await vi.waitFor(() => expect(h.socket.sent).toHaveLength(3));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(h.events).toHaveLength(0); expect(h.lookups()).toBe(1);
  expect(h.health).not.toContain('backoff'); expect(h.socket.listenerCount('message')).toBe(1);
  clock += 31_000; limited = false;
  h.emit(payload(message(4, { channel: 'D1', channel_type: 'im' }), 'E4'));
  await vi.waitFor(() => expect(h.events).toHaveLength(1));
  expect(h.events[0]).toMatchObject({ chat: { id: 'private:T1:U1:D1' } });
  expect(h.lookups()).toBe(2);
  expect(h.calls.filter(method => method === 'apps.connections.open')).toHaveLength(1);
  await h.connection.stop();
 });

 it('drops one event whose channel is gone without tearing the socket down', async () => {
  const h = harness(channel => { if (channel === 'C9') throw slackError('channel_not_found'); return member(channel); });
  h.connection.start(); await vi.waitFor(() => expect(h.socket.listenerCount('message')).toBe(1));
  h.emit(payload(message(1, { channel: 'C9', text: '<@U1> a' }), 'E1'));
  h.emit(payload(message(2, { text: '<@U1> b' }), 'E2'));
  await vi.waitFor(() => expect(h.events).toHaveLength(1));
  expect(h.health).not.toContain('backoff');
  await h.connection.stop();
 });

 it('processes a redelivered envelope it never saw, and still deduplicates one it did', async () => {
  const h = harness(member);
  h.connection.start(); await vi.waitFor(() => expect(h.socket.listenerCount('message')).toBe(1));
  h.emit(payload(message(1, { text: '<@U1> a' }), 'E1'), { retry_attempt: 1, retry_reason: 'timeout' });
  await vi.waitFor(() => expect(h.events).toHaveLength(1));
  h.emit(payload(message(1, { text: '<@U1> a' }), 'E1'), { retry_attempt: 2, retry_reason: 'timeout' });
  h.emit(payload(message(2, { text: '<@U1> b' }), 'E2'));
  await vi.waitFor(() => expect(h.events).toHaveLength(2));
  expect(h.socket.sent).toHaveLength(3);
  await h.connection.stop();
 });
});

describe('Slack button clearing', () => {
 function recording(history: unknown = { messages: [] }, replies: unknown = { messages: [] }) {
  const calls: Array<[SlackMethod, Record<string, unknown>]> = [];
  const wire: SlackWire = { socket() { throw new Error('no socket'); }, async call(method, body) {
   calls.push([method, body]);
   if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' };
   if (method === 'chat.postMessage') return { channel: body.channel, ts: '1800000000.000001' };
   if (method === 'conversations.history') return history;
   if (method === 'conversations.replies') return replies;
   return { ok: true };
  } };
  return { calls, transport: slackTransport(wire) };
 }
 const updates = (calls: Array<[SlackMethod, Record<string, unknown>]>) => calls.filter(([method]) => method === 'chat.update').map(([, body]) => body);
 it('keeps the posted text and sections, removing only the actions', async () => {
  const { calls, transport } = recording();
  const receipt = await transport.send('group:T1:U1:C1', { text: 'Choose & go', buttons: [[{ text: 'Yes', data: 'opaque' }]] });
  await transport.clearButtons(receipt);
  expect(updates(calls)).toEqual([{ channel: 'C1', ts: '1800000000.000001', text: 'Choose & go', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Choose & go', verbatim: true } }] }]);
 });
 it('recovers the text of its own message after a restart, and never blanks a message it cannot read', async () => {
  const restarted = recording({ messages: [{ ts: '1800000000.000001', user: 'U1', text: 'Earlier notice' }] });
  await restarted.transport.clearButtons({ chatId: 'group:T1:U1:C1', messageId: '1800000000.000001' });
  expect(updates(restarted.calls)).toEqual([{ channel: 'C1', ts: '1800000000.000001', text: 'Earlier notice', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Earlier notice', verbatim: true } }] }]);
  for (const history of [{ messages: [] }, { messages: [{ ts: '1800000000.000001', user: 'U2', text: 'not ours' }] }]) {
   const unknown = recording(history);
   await unknown.transport.clearButtons({ chatId: 'group:T1:U1:C1', messageId: '1800000000.000001' });
   expect(updates(unknown.calls)).toEqual([]);
  }
 });
 it('finds its own threaded reply after a restart, which conversations.history never returns', async () => {
  const thread = recording({ messages: [] }, { messages: [{ ts: '1700000000.000001', user: 'U2', text: 'root' }, { ts: '1800000000.000001', user: 'U1', text: 'Threaded question' }] });
  await thread.transport.clearButtons({ chatId: 'group:T1:U1:C1', messageId: '1800000000.000001' });
  expect(updates(thread.calls)).toEqual([{ channel: 'C1', ts: '1800000000.000001', text: 'Threaded question', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Threaded question', verbatim: true } }] }]);
  const foreign = recording({ messages: [] }, { messages: [{ ts: '1800000000.000001', user: 'U2', text: 'not ours' }] });
  await foreign.transport.clearButtons({ chatId: 'group:T1:U1:C1', messageId: '1800000000.000001' });
  expect(updates(foreign.calls)).toEqual([]);
 });
});
