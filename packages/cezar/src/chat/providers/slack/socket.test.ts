import { it, expect, vi } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { slackTransport } from './transport.ts';
import type { ReceiveJournal } from '../../connection.ts';
it('speaks Socket Mode over loopback WebSocket, acknowledges retries, reconnects and stops', async () => {
 const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
 const port = (server.address() as AddressInfo).port;
 const peers: WebSocket[] = [], acknowledgements: string[] = [], events: unknown[] = [];
 server.on('connection', peer => { peers.push(peer); peer.on('message', frame => acknowledgements.push(frame.toString())); });
 let opens = 0;
 const now = Date.now(), ts = `${Math.floor(now / 1000)}.${String(now % 1000).padStart(3, '0')}001`;
 const connection = slackTransport({
  socket: () => new WebSocket(`ws://127.0.0.1:${port}`),
  async call(method, body, _signal, valid) {
   expect(valid?.()).toBe(true);
   if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' };
   if (method === 'apps.connections.open') { opens++; return { url: 'wss://wss-primary.slack.com/mock' }; }
   if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, user: 'U2' } };
   throw new Error('unexpected method');
  },
 }).connect({} as ReceiveJournal, { needed: () => true, assertCredentials: async () => {}, onHealth() {}, process: async () => {}, accept: async event => { events.push(event); } }, () => now);
 try {
  connection.start(); await vi.waitFor(() => expect(peers).toHaveLength(1));
  const payload = { team_id: 'T1', event_id: 'E1', authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', channel: 'D1', user: 'U2', text: '/tasks', ts } };
  peers[0]!.send(JSON.stringify({ type: 'events_api', envelope_id: 'first', payload }));
  await vi.waitFor(() => expect(events).toHaveLength(1));
  peers[0]!.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }));
  await vi.waitFor(() => expect(peers).toHaveLength(2), { timeout: 3000 });
  peers[1]!.send(JSON.stringify({ type: 'events_api', envelope_id: 'retry', retry_attempt: 1, payload }));
  // Processing is serialized: once a later event lands, the redelivery has been handled.
  peers[1]!.send(JSON.stringify({ type: 'events_api', envelope_id: 'later', payload: { ...payload, event_id: 'E2', event: { ...payload.event, text: '/status', ts: ts.replace(/001$/, '002') } } }));
  await vi.waitFor(() => expect(events).toHaveLength(2));
  expect(events.map(event => (event as { id: string }).id)).toEqual(['msg:D1:' + ts, 'msg:D1:' + ts.replace(/001$/, '002')]); expect(opens).toBe(2);
 } finally { await connection.stop(); for (const peer of peers) peer.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
 expect(connection.health().state).toBe('stopped');
});
