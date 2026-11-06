import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
export async function slackWireFixture() {
 const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
 await once(server, 'listening')
 let current, sequence = 0
 const sent = [], callbacks = []
 const ts = () => (Date.now() / 1000 + (++sequence % 1000) / 1000000).toFixed(6)
 server.on('connection', socket => { current = socket; socket.on('message', raw => callbacks.push(JSON.parse(raw.toString()))) })
 const emit = (type, payload) => {
  if (!current || current.readyState !== WebSocket.OPEN) throw new Error('Socket not ready')
  current.send(JSON.stringify({ envelope_id: 'e' + ++sequence, type, payload }))
 }
 return {
  sent, callbacks, token: 'xoxb-fixture-bot-token',
  socket: () => new WebSocket('ws://127.0.0.1:' + server.address().port),
  async call(method, body, signal, valid) {
   if (signal?.aborted || valid?.() === false) throw new Error('Fixture effect fenced')
   if (method === 'auth.test') return { team_id: 'T1', user_id: 'U1' }
   if (method === 'apps.connections.open') return { url: 'wss://fixture.slack.com' }
   if (method === 'conversations.info') return { channel: { id: body.channel, is_im: body.channel === 'D1', is_member: true, user: 'U2' } }
   if (method === 'conversations.members') return { members: ['U1', 'U2'] }
   if (method === 'chat.postMessage') { const message = { ...body, ts: ts(), user: 'U1' }; sent.push(message); return message }
   if (method === 'chat.update') return {}
   throw new Error('Unexpected Slack method ' + method)
  },
  message(text, group = false, reply) { emit('events_api', { team_id: 'T1', event_id: 'event' + ++sequence, authorizations: [{ user_id: 'U1', is_bot: true }], event: { type: 'message', channel: group ? 'C1' : 'D1', user: 'U2', text: text.replace('@bot', '<@U1>'), ts: ts(), ...(reply ? { thread_ts: reply.ts } : {}) } }) },
  button(message, value) { emit('interactive', { type: 'block_actions', team: { id: 'T1' }, message: { user: 'U1' }, user: { id: 'U2' }, container: { channel_id: message.channel, message_ts: message.ts }, actions: [{ action_id: 'cezar_0', value, action_ts: ts() }] }) },
  async close() { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)) },
 }
}
