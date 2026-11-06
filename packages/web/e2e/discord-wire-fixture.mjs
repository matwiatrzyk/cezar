import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
/** Loopback-only wire fixture for the root's cockpit setup/upgrade e2e server. */
export async function discordWireFixture() {
 const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
 await once(server, 'listening')
 const address = server.address()
 if (!address || typeof address === 'string') throw new Error('Expected loopback address')
 const bot = { id: '100000000000000001', username: 'FixtureBot', bot: true }
 const user = { id: '100000000000000002', username: 'FixturePerson' }
 const privateChannel = '100000000000000003', guildChannel = '100000000000000004', guild = '100000000000000005'
 let sequence = 0, messageSequence = 100, current
 const sent = [], callbacks = []
 server.on('connection', socket => {
  current = socket
  socket.on('message', raw => {
   const frame = JSON.parse(raw.toString())
   if (frame.op === 1) socket.send(JSON.stringify({ op: 11, d: null }))
   if (frame.op === 2) socket.send(JSON.stringify({ op: 0, t: 'READY', s: ++sequence, d: { session_id: 'fixture', resume_gateway_url: 'wss://gateway.discord.gg', user: bot } }))
   if (frame.op === 6) socket.send(JSON.stringify({ op: 0, t: 'RESUMED', s: ++sequence, d: {} }))
  })
  socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 1000 } }))
 })
 const emit = (t, d) => { if (!current || current.readyState !== WebSocket.OPEN) throw new Error('Gateway is not connected'); current.send(JSON.stringify({ op: 0, t, s: ++sequence, d })) }
 return {
  token: `${'a'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(27)}`, bot, user, sent, callbacks,
  privateId: `discord:dm:${privateChannel}`, groupId: `discord:guild:${guild}:${guildChannel}`,
  socket: () => new WebSocket(`ws://127.0.0.1:${address.port}`),
  async request(method, path, body, signal, valid) {
   if (signal?.aborted || valid?.() === false) throw new Error('Fixture effect fenced')
   if (path === '/users/@me') return bot
   if (path === '/gateway/bot') return { url: 'wss://gateway.discord.gg', shards: 1, session_start_limit: { remaining: 100 } }
   if (path === `/channels/${privateChannel}`) return { id: privateChannel, type: 1, recipients: [user] }
   if (path === `/channels/${guildChannel}`) return { id: guildChannel, type: 0, guild_id: guild, permission_overwrites: [] }
   if (path === `/guilds/${guild}`) return { id: guild, owner_id: user.id }
   if (path === `/guilds/${guild}/roles`) return [{ id: guild, permissions: '68608' }]
   if (path.startsWith(`/guilds/${guild}/members/`)) return { user: path.endsWith(bot.id) ? bot : user, roles: [] }
   if (method === 'POST' && /^\/channels\/\d+\/messages$/.test(path)) { const message = { id: String(++messageSequence), channel_id: path.split('/')[2], author: bot, ...body }; sent.push(message); return message }
   if (method === 'PATCH') return {}
   if (method === 'POST' && path.endsWith('/callback')) { callbacks.push({ path, body }); return undefined }
   throw new Error('Unimplemented simulated Discord request')
  },
  message(content, group = false, reply) { const channel_id = group ? guildChannel : privateChannel; emit('MESSAGE_CREATE', { id: String(++messageSequence), channel_id, ...(group ? { guild_id: guild } : {}), author: user, content: content.replace('@bot', '<@' + bot.id + '>'), timestamp: new Date().toISOString(), ...(reply ? { message_reference: { message_id: reply.id, channel_id }, referenced_message: reply } : {}) }) },
  button(message, custom_id, group = false) { emit('INTERACTION_CREATE', { id: String(++messageSequence), application_id: bot.id, type: 3, token: 'fixture-interaction-only', channel_id: message.channel_id, ...(group ? { guild_id: guild, member: { user } } : { user }), data: { custom_id, component_type: 2 }, message }) },
  async close() { for (const socket of server.clients) socket.terminate(); await new Promise(resolve => server.close(resolve)) },
 }
}
