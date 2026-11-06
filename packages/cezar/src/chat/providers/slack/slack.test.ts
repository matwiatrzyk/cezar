import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { slackTransport } from './transport.ts';
import { createSlackWire, slackError, type SlackWire } from './client.ts';
import { encodeSlackCredentials, decodeSlackCredentials, slackChat } from './identity.ts';
import { normalizeSlackEnvelope } from './normalize.ts';
import { slackPresentation, renderSlackNotification } from './presentation.ts';
import type { ChatConnectionOptions, ReceiveJournal } from '../../connection.ts';
const token = encodeSlackCredentials({ appToken: 'xapp-test-app-token', botToken: 'xoxb-test-bot-token' });
const now = 1800000000000;
const inspect = async (channel: string) => ({ id: `${channel === 'D1' ? 'private' : 'group'}:T1:U1:${channel}`, kind: channel === 'D1' ? 'private' as const : 'group' as const, eligible: true });
const event = (extra = {}) => ({ envelope_id: 'envelope-1', type: 'events_api', payload: { team_id: 'T1', event_id: 'Ev1', authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', user: 'U2', channel: 'C1', ts: '1800000000.000001', text: 'hello', ...extra } } });
function wire(): SlackWire {
 return { socket() { throw new Error('unexpected socket'); }, async call(method, body) {
  if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' };
  if (method === 'conversations.info') return { channel: { id: body.channel, is_im: body.channel === 'D1', is_mpim: body.channel === 'G1', is_member: true, user: 'U2' } };
  if (method === 'chat.postMessage') return { channel: body.channel, ts: '1800000000.000001' };
  if (method === 'conversations.members') return { members: ['U1', 'U2'] };
  return { ok: true };
 } };
}
describe('Slack platform boundary', () => {
 it('validates opaque credentials without leaking values', () => {
  expect(decodeSlackCredentials(token)).toEqual({ appToken: 'xapp-test-app-token', botToken: 'xoxb-test-bot-token' });
  expect(() => decodeSlackCredentials('{"botToken":"secret"}')).toThrow('Chat credentials are unavailable');
 });
 it('preserves verified private/group and bot namespace without cache across restart', async () => {
  for (const id of ['private:T1:U1:D1', 'group:T1:U1:G1', 'group:T1:U1:C1']) {
   expect((await slackTransport(wire()).inspect(id)).kind).toBe(slackChat(id).kind);
   expect(slackPresentation.isGroup(id)).toBe(id.startsWith('group:'));
  }
  await expect(slackTransport(wire()).inspect('private:T1:U1:G1')).rejects.toThrow();
  await expect(slackTransport(wire()).send('private:T1:U9:D1', { text: 'secret' })).rejects.toThrow();
 });
 it('normalizes thread roots and discovery, ignores bot/edited/stale/cross-workspace messages', async () => {
  const normalized = await normalizeSlackEnvelope(event({ thread_ts: '1799999999.000001' }), 'T1:U1', inspect, now);
  expect(normalized).toMatchObject({ kind: 'message', addressed: false, replyTo: { chatId: 'group:T1:U1:C1', messageId: '1799999999.000001' } });
  expect(await normalizeSlackEnvelope(event({ text: '<@U1> cezar start abc_123' }), 'T1:U1', inspect, now)).toMatchObject({ kind: 'start', code: 'abc_123' });
  for (const extra of [{ bot_id: 'B1' }, { subtype: 'message_changed' }, { ts: '1700000000.000001' }, { user: 'U1' }]) expect(await normalizeSlackEnvelope(event(extra), 'T1:U1', inspect, now)).toBeUndefined();
  expect(await normalizeSlackEnvelope(event(), 'T2:U1', inspect, now)).toBeUndefined();
 });
 it('uses immediate container receipt, not reply timestamp, for buttons', async () => {
  expect(await normalizeSlackEnvelope({ type: 'interactive', envelope_id: 'tap', payload: { type: 'block_actions', team: { id: 'T1' }, message: { user: 'U1' }, user: { id: 'U2' }, container: { channel_id: 'C1', message_ts: '1799999999.000001' }, actions: [{ action_id: 'cezar_0', value: 'opaque', action_ts: '1800000000.000001' }] } }, 'T1:U1', inspect, now)).toMatchObject({ kind: 'button', receipt: { chatId: 'group:T1:U1:C1', messageId: '1799999999.000001' }, data: 'opaque' });
 });
 it('maps explicit outbound thread roots and rejects cross-chat threads before sending', async () => {
  const original = wire(), calls: Array<Record<string, unknown>> = [];
  const transport = slackTransport({ ...original, async call(method, body) { if (method === 'chat.postMessage') calls.push(body); return original.call(method, body); } });
  const message = { text: 'reply', replyTo: { chatId: 'private:T1:U1:D1', messageId: '1799999999.000001' } };
  await transport.send(message.replyTo.chatId, message);
  expect(calls[0]).toMatchObject({ channel: 'D1', thread_ts: '1799999999.000001' });
  await expect(transport.send('group:T1:U1:C1', message)).rejects.toThrow();
  expect(calls).toHaveLength(1);
 });
 it('does not guess negative membership on transient or malformed responses', async () => {
  const transport = slackTransport({ ...wire(), async call(method, body) { if (method === 'conversations.members') throw slackError('network'); return wire().call(method, body); } });
  expect(await transport.isMember('group:T1:U1:C1', 'U2')).toBeUndefined();
 });
 it('checks authorization after credential resolution and sends no token in URLs/errors', async () => {
  let allowed = true;
  const fetcher = vi.fn<typeof fetch>();
  const client = createSlackWire(async () => { allowed = false; return token; }, { fetch: fetcher });
  await expect(client.call('auth.test', {}, undefined, () => allowed)).rejects.toThrow('blocked');
  expect(fetcher).not.toHaveBeenCalled();
  const failed = createSlackWire(async () => token, { fetch: async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth', detail: token })) });
  await expect(failed.call('auth.test', {})).rejects.toThrow('Chat transport: auth');
 });
 it('sends the correct token, suppresses redirects, classifies rate limits and validates socket hosts', async () => {
  const requests: Array<[string, RequestInit | undefined]> = [];
  const client = createSlackWire(async () => token, { fetch: async (url, init) => { requests.push([String(url), init]); return new Response('{"ok":true}'); } });
  await client.call('auth.test', {}); await client.call('apps.connections.open', {});
  expect(requests[0]![1]?.headers).toMatchObject({ Authorization: 'Bearer xoxb-test-bot-token' });
  expect(requests[1]![1]?.headers).toMatchObject({ Authorization: 'Bearer xapp-test-app-token' });
  expect(requests.every(([url, init]) => !url.includes('xapp') && init?.redirect === 'error')).toBe(true);
  expect(() => client.socket('wss://slack.com.evil.invalid/path', () => true)).toThrow();
  const limited = createSlackWire(async () => token, { fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '2' } }) });
  await expect(limited.call('chat.postMessage', {})).rejects.toMatchObject({ failure: { kind: 'rate_limited', retryAfterMs: 2000 } });
 });
 it('preserves the full rendered text in button blocks without splitting entities', async () => {
  let sent: Record<string, unknown> = {};
  const original = wire();
  const transport = slackTransport({ ...original, async call(method, body) { if (method === 'chat.postMessage') sent = body; return original.call(method, body); } });
  const text = 'x'.repeat(2998) + '&amp;' + 'y'.repeat(990);
  await transport.send('private:T1:U1:D1', { text, buttons: [[{ text: 'Yes', data: 'opaque' }]] });
  const sections = (sent.blocks as Array<{ type: string; text?: { text: string } }>).filter(block => block.type === 'section');
  expect(sections.map(block => block.text!.text).join('')).toBe(text);
  expect(sections.every(block => block.text!.text.length <= 3000 && !block.text!.text.endsWith('&a'))).toBe(true);
 });
 it('rejects events addressed to another app and deliveries older than the connection cutoff', async () => {
  const other = event(); other.payload.authorizations[0]!.user_id = 'U9';
  expect(await normalizeSlackEnvelope(other, 'T1:U1', inspect, now)).toBeUndefined();
  expect(await normalizeSlackEnvelope(event(), 'T1:U1', inspect, now + 1000, now + 1000)).toBeUndefined();
 });
 it('renders only filtered notification fields and excludes local cockpit links', () => {
  const at = '2026-11-04T00:00:00Z';
  const notification = { id: 'evt_11111111-1111-4111-8111-111111111111', schemaVersion: 1, occurredAt: at, sequence: 1,
   source: { instanceId: 'private-instance', projectId: 'private-project', mode: 'local' }, type: 'task.attention_required',
   task: { id: 'abcdefgh-task', status: 'waiting', previousStatus: 'running' }, links: { cockpit: 'https://cockpit.example/private' },
   data: { episodeId: 'ep', since: at, reason: 'question', questions: [{ question: '<@everyone> Choose?' }] } };
  const { text } = renderSlackNotification(JSON.stringify(notification), { chatId: 'group:T1:U1:C1', replyHint: false });
  expect(text).toContain('Choose?'); expect(text).not.toContain('<@'); expect(text).not.toContain('private-project'); expect(text).not.toContain('cockpit.example'); expect(text).not.toContain('Reply in');
 });
 it('renders within limits without mentions or partial entities', () => {
  const result = slackPresentation.formatText('<@U123>&'.repeat(2000));
  expect(result.length).toBeLessThanOrEqual(4000); expect(result).not.toContain('<@'); expect(result).not.toMatch(/&(?:a|am|amp|l|lt|g|gt)?…$/);
 });
 it('does no I/O during construction or without demand, and parks unavailable credentials', async () => {
  const original = wire(), call = vi.fn(original.call), socket = vi.fn(original.socket);
  const transport = slackTransport({ call, socket });
  const options: ChatConnectionOptions = { needed: () => false, assertCredentials: async () => {}, onHealth() {}, process: async () => {}, accept: async () => {} };
  const idle = transport.connect({} as ReceiveJournal, options);
  expect(call).not.toHaveBeenCalled(); idle.start(); await idle.stop(); expect(call).not.toHaveBeenCalled();
  const failed = transport.connect({} as ReceiveJournal, { ...options, needed: () => true, assertCredentials: async () => { throw slackError('invalid_auth'); } });
  failed.start(); await vi.waitFor(() => expect(failed.health().state).toBe('credentials-unavailable'));
  expect(socket).not.toHaveBeenCalled(); expect(call).not.toHaveBeenCalled(); await failed.stop();
 });
 it('acknowledges before slow work, deduplicates, and drains pending work on stop', async () => {
  class Socket extends EventEmitter { readyState = 1; sent: string[] = []; send(data: string) { this.sent.push(data); } terminate() { this.emit('close'); } ping() {} }
  const socket = new Socket(); let accepted = 0, release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const testWire: SlackWire = { ...wire(), socket: () => socket as unknown as WebSocket, async call(method, body) { if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/test' }; return wire().call(method, body); } };
  const options: ChatConnectionOptions = { needed: () => true, assertCredentials: async () => {}, onHealth() {}, process: async () => {}, accept: async () => { accepted++; await wait; } };
  const connection = slackTransport(testWire).connect({} as ReceiveJournal, options, () => now);
  connection.start(); await vi.waitFor(() => expect(socket.listenerCount('message')).toBe(1));
  socket.emit('message', Buffer.from(JSON.stringify(event()))); socket.emit('message', Buffer.from(JSON.stringify(event())));
  expect(socket.sent).toHaveLength(2);
  await vi.waitFor(() => expect(accepted).toBe(1));
  let stopped = false; const stop = connection.stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false); release(); await stop;
  expect(accepted).toBe(1); expect(connection.health().state).toBe('stopped');
 });
});
