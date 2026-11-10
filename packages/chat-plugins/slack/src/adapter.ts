import { ExtensionChatError, type ChatMessage, type ChatReceipt, type ExtensionChatAdapter, type ExtensionChatBatch, type ExtensionChatOperationContext } from '@open-mercato/cezar-extension-sdk/chat'
import { request as undiciRequest, Agent } from 'undici'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import WebSocket from 'ws'

type Json = Record<string, unknown>
type Credentials = { appToken: string; botToken: string }
type Address = { address: string; family: number }
type ChatButtonRow = NonNullable<ChatMessage['buttons']>[number]
type ChatButton = ChatButtonRow[number]
const id = (v: unknown) => typeof v === 'string' && /^[A-Z0-9]+$/.test(v) ? v : undefined
const ts = (v: unknown) => typeof v === 'string' && /^\d{10,16}\.\d{6}$/.test(v) ? v : undefined
const obj = (v: unknown): Json | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined
const text = (v: unknown, max = 65536) => typeof v === 'string' && v.length <= max ? v : undefined
const fail = (kind: 'auth'|'conflict'|'rate_limited'|'gone'|'transient'|'blocked', retryAfterMs?: number) => new ExtensionChatError({ kind, ...(retryAfterMs ? { retryAfterMs } : {}) })
function assertCredentials(c: Credentials) { if (!/^xapp-[A-Za-z0-9-]{10,}$/.test(c.appToken) || !/^xoxb-[A-Za-z0-9-]{10,}$/.test(c.botToken)) throw fail('auth') }
const ipv4 = (address: string) => address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0)
const in4 = (address: number, network: string, bits: number) => Math.floor(address / 2 ** (32 - bits)) === Math.floor(ipv4(network) / 2 ** (32 - bits))
function publicIpv4(address: string) {
 const p = address.split('.').map(Number); const n = ipv4(address)
 if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false
 if ([['0.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]].some(([network, bits]) => in4(n, network as string, bits as number))) return false
 if ([['10.0.0.0', 8], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]].some(([network, bits]) => in4(n, network as string, bits as number))) return false
 return n !== 0xffffffff
}
function ipv6(address: string): bigint {
 let value = address.toLowerCase()
 if (value.includes('.')) { const colon = value.lastIndexOf(':'); const tail = ipv4(value.slice(colon + 1)); value = value.slice(0, colon + 1) + Math.floor(tail / 65536).toString(16) + ':' + (tail % 65536).toString(16) }
 const [left = '', right] = value.split('::'); const a = left ? left.split(':') : []; const b = right ? right.split(':') : []
 const words = right === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b]
 return words.reduce((result, word) => (result << 16n) + BigInt(`0x${word}`), 0n)
}
const in6 = (address: bigint, network: string, bits: number) => (address >> BigInt(128 - bits)) === (ipv6(network) >> BigInt(128 - bits))
function publicAddress(input: string) {
 const address = input.replace(/^\[|\]$/g, '')
 if (isIP(address) === 4) return publicIpv4(address)
 if (isIP(address) !== 6 || address.includes('%')) return false
 const value = ipv6(address)
 if (value === 0n || value === 1n || in6(value, 'fc00::', 7) || in6(value, 'fe80::', 10) || in6(value, 'ff00::', 8)) return false
 if (in6(value, '::ffff:0:0', 96) || in6(value, '::', 96)) {
  const embedded = Number(value & 0xffffffffn)
  return publicIpv4([24, 16, 8, 0].map(shift => (embedded >>> shift) & 255).join('.'))
 }
 return in6(value, '2000::', 3) && !in6(value, '2001::', 23) && !in6(value, '2001:db8::', 32) && !in6(value, '2002::', 16) && !in6(value, '3fff::', 20)
}
async function pin(hostname: string, lookup: (hostname: string, signal?: AbortSignal) => Promise<Address[]>, signal?: AbortSignal, timeoutMs = 10000) {
 const controller = new AbortController(); let timedOut = false; let timer: ReturnType<typeof setTimeout> | undefined
 const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true })
 try {
  if (signal?.aborted) throw fail('blocked')
  const addresses = await new Promise<Address[]>((resolve, reject) => {
   const onAbort = () => { controller.abort(); reject(fail(timedOut ? 'transient' : 'blocked')) }
   controller.signal.addEventListener('abort', onAbort, { once: true })
   timer = setTimeout(() => { timedOut = true; onAbort() }, timeoutMs)
   Promise.resolve().then(() => lookup(hostname, controller.signal)).then(resolve, reject)
  })
  const valid = addresses.filter(a => publicAddress(a.address) && a.family === isIP(a.address)); if (!valid.length || valid.length !== addresses.length) throw fail('blocked'); return valid[0]!
 } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

export type SlackRequestOptions = { lookup?: (hostname: string, signal?: AbortSignal) => Promise<Address[]>; request?: typeof undiciRequest }
export function slackRequest(credentials: Credentials, options: SlackRequestOptions = {}) {
 assertCredentials(credentials)
 return async (method: string, body: Json, operation?: ExtensionChatOperationContext): Promise<unknown> => {
  await operation?.assertActive(); operation?.signal.throwIfAborted(); const controller = new AbortController(); const abort = () => controller.abort(); operation?.signal.addEventListener('abort', abort, { once: true }); const timer = setTimeout(abort, method === 'apps.connections.open' ? 15000 : 10000); let dispatcher: Agent | undefined
  try {
   const target = await pin('slack.com', options.lookup ?? (async h => dnsLookup(h, { all: true, verbatim: true })), controller.signal, method === 'apps.connections.open' ? 15000 : 10000); dispatcher = new Agent({ connections: 1, pipelining: 1, connect: { rejectUnauthorized: true, autoSelectFamily: false, lookup(_h, opts, cb) { if (opts.all) cb(null, [target]); else cb(null, target.address, target.family) } } })
   await operation?.assertActive(); const form = new URLSearchParams(); for (const [key, value] of Object.entries(body)) if (value !== undefined) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
   const response = await (options.request ?? undiciRequest)(`https://slack.com/api/${method}`, { dispatcher, method: 'POST', signal: controller.signal, headersTimeout: 10000, bodyTimeout: 10000, headers: { authorization: `Bearer ${method === 'apps.connections.open' ? credentials.appToken : credentials.botToken}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() }); const chunks: Buffer[] = []; let length = 0; for await (const chunk of response.body) { length += chunk.length; if (length > 1024 * 1024) throw fail('blocked'); chunks.push(Buffer.from(chunk)) }
   const result = obj(JSON.parse(Buffer.concat(chunks).toString('utf8'))); if (response.statusCode === 429) throw fail('rate_limited', 5000); if (response.statusCode === 401) throw fail('auth'); if (response.statusCode >= 500) throw fail('transient'); if (result?.ok !== true) { const error = String(result?.error); throw fail(error === 'too_many_connections' ? 'conflict' : ['channel_not_found', 'not_in_channel', 'is_archived'].includes(error) ? 'gone' : ['invalid_auth', 'token_revoked', 'token_expired'].includes(error) ? 'auth' : 'blocked') } return result
  } catch (error) { if (error instanceof ExtensionChatError) throw error; if (operation?.signal.aborted || controller.signal.aborted) throw fail('blocked'); throw fail('transient') } finally { clearTimeout(timer); operation?.signal.removeEventListener('abort', abort); await dispatcher?.close().catch(() => undefined) }
 }
}

// Slack decodes these three entities even in plain-text messages. Escape once at
// the wire boundary so literal entities and explicit mention/link syntax survive.
function escapeText(value: string): string {
 return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
function textBlocks(value: string) {
 const chunks: string[] = []
 let chunk = ''
 // Split only between complete code points/entities, within Slack's section limit.
 for (const char of value) {
  const escaped = escapeText(char)
  if (chunk.length + escaped.length > 3000) { chunks.push(chunk); chunk = '' }
  chunk += escaped
 }
 if (chunk) chunks.push(chunk)
 return chunks.map(text => ({ type: 'section', text: { type: 'plain_text', text, emoji: false } }))
}

function chat(team: string, bot: string, channel: string, kind: 'private'|'group') { return { id: `${kind}:${team}:${bot}:${channel}`, kind } as const }
function parseChat(value: string, team: string, bot: string) { const m = /^(private|group):([A-Z0-9]+):([A-Z0-9]+):([A-Z0-9]+)$/.exec(value); if (!m || m[2] !== team || m[3] !== bot) throw fail('blocked'); return { kind: m[1] as 'private'|'group', channel: m[4]! } }
function normalize(raw: Json, team: string, bot: string, inspect: (channel: string, op?: ExtensionChatOperationContext) => Promise<{ id: string; kind: 'private'|'group'; eligible: boolean }>, now: number, op?: ExtensionChatOperationContext) {
 const envelope = obj(raw); if (!envelope || typeof envelope.type !== 'string') return undefined
 const native = obj(envelope.payload)
 if (envelope.type === 'slash_commands') {
  if (native?.team_id !== team || native.user_id === bot || native.command !== '/cezar' || typeof native.channel_id !== 'string' || typeof native.text !== 'string' || native.text.length > 65536) return undefined
  return inspect(native.channel_id, op).then(ref => {
   if (!ref.eligible) return undefined
   const input = String(native.text).trim().replace(/^\//, '') || 'help'
   const command = /^(tasks|status|help)(?=\s|$)/i.exec(input)?.[1]?.toLowerCase() ?? 'help'
   const id = typeof envelope.envelope_id === 'string' && envelope.envelope_id.length <= 128 ? `slash:${envelope.envelope_id}` : `slash:${native.channel_id}:${native.user_id}:${Date.now()}`
   return { kind: 'message' as const, id, messageId: id, chat: { id: ref.id, kind: ref.kind }, user: { id: String(native.user_id), label: String(native.user_id) }, at: now, text: `/${command}${input.slice(command.length) ? input.slice(command.length) : ''}`.trim(), addressed: true }
  })
 }
 if (envelope.type === 'interactive') {
  const user = obj(native?.user), teamInfo = obj(native?.team), message = obj(native?.message), container = obj(native?.container)
  const actions = Array.isArray(native?.actions) ? native.actions as unknown[] : []
  const action = obj(actions[0])
  if (native?.type !== 'block_actions' || teamInfo?.id !== team || message?.user !== bot || typeof user?.id !== 'string' || typeof container?.channel_id !== 'string' || typeof container?.message_ts !== 'string' || !/^\d{10,16}\.\d{6}$/.test(container.message_ts) || actions.length !== 1 || !action || typeof action.action_id !== 'string' || !/^cezar_\d+$/.test(action.action_id) || typeof action.value !== 'string' || action.value.length > 128 || typeof action.action_ts !== 'string' || !/^\d{10,16}\.\d{6}$/.test(action.action_ts)) return undefined
  const actionAt = Number(action.action_ts) * 1000; if (!Number.isFinite(actionAt) || actionAt < now - 15 * 60_000 || actionAt > now + 60_000) return undefined
  return inspect(container.channel_id, op).then(ref => ref.eligible ? { kind: 'button' as const, id: `button:${container.channel_id}:${user.id}:${typeof action.action_ts === 'string' ? action.action_ts : envelope.envelope_id}`, chat: { id: ref.id, kind: ref.kind }, user: { id: user.id as string, label: user.id as string }, receipt: { chatId: ref.id, messageId: container.message_ts as string }, data: action.value as string } : undefined)
 }
 if (envelope.type !== 'events_api') return undefined
 const payload = native; const event = obj(payload?.event); const auth = Array.isArray(payload?.authorizations) ? payload!.authorizations as unknown[] : []; if (!payload || !event || payload.team_id !== team || !auth.some(a => { const r = obj(a); return r?.is_bot === true && r.user_id === bot })) return undefined
 if (event.type === 'member_left_channel' && event.user === bot && typeof event.channel === 'string') return { kind: 'membership' as const, id: typeof payload.event_id === 'string' ? payload.event_id : `member:${event.channel}:${now}`, chat: { id: `group:${team}:${bot}:${event.channel}`, kind: 'group' as const }, reason: 'removed' as const }
 const channel = id(event.channel), user = id(event.user), stamp = ts(event.ts); if (!channel || !user || !stamp || event.bot_id || event.user === bot || event.subtype) return undefined; const when = Number(stamp) * 1000; if (when < now - 15 * 60_000 || when > now + 60_000) return undefined
 return inspect(channel, op).then(ref => { if (!ref.eligible) return undefined; const mention = `<@${bot}>`; const addressed = ref.kind === 'private' || String(event.text ?? '').includes(mention); const body = text(event.text); if (body === undefined || (ref.kind === 'group' && !addressed && event.thread_ts === undefined)) return undefined; const clean = body.replaceAll(mention, '').trim().replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'); const thread = ts(event.thread_ts); return { kind: 'message' as const, id: `msg:${channel}:${stamp}`, chat: { id: ref.id, kind: ref.kind }, user: { id: user, label: user }, at: when, text: clean, addressed, messageId: stamp, ...(thread ? { replyTo: { chatId: ref.id, messageId: thread } } : {}) } })
}

export function createSlackAdapter(credentials: Record<string, string>, request = slackRequest(credentials as Credentials), options: { lookup?: (hostname: string) => Promise<Address[]>; socket?: (url: string, lookup: (hostname: string, options: object, callback: (...args: unknown[]) => void) => void) => WebSocket } = {}): ExtensionChatAdapter {
 const c = credentials as Credentials; assertCredentials(c); let team = '', bot = '', username = ''; let socket: WebSocket | undefined; let socketWait: Promise<void> | undefined; const queue: Json[] = []; let wake: (() => void) | undefined; let sequence = 0; let disposed = false; const lifecycle = new AbortController()
 const call = (method: string, body: Json, op?: ExtensionChatOperationContext) => request(method, body, op)
 const inspect = async (channel: string, op?: ExtensionChatOperationContext) => { const result = obj(await call('conversations.info', { channel }, op)); const row = obj(result?.channel); if (!row || row.id !== channel) return { id: channel, kind: 'group' as const, eligible: false }; const kind = row.is_im === true && row.is_mpim !== true ? 'private' as const : 'group' as const; return { id: chat(team, bot, channel, kind).id, kind, eligible: row.is_archived !== true && (kind === 'private' || row.is_member === true) } }
 const open = async (op?: ExtensionChatOperationContext) => { const opened = obj(await call('apps.connections.open', {}, op)); const raw = text(opened?.url); let parsed: URL; try { parsed = new URL(raw ?? '') } catch { throw fail('blocked') } if (parsed.protocol !== 'wss:' || (parsed.hostname !== 'slack.com' && !parsed.hostname.endsWith('.slack.com')) || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw fail('blocked'); const signal = new AbortController(); const abort = () => signal.abort(); lifecycle.signal.addEventListener('abort', abort, { once: true }); op?.signal.addEventListener('abort', abort, { once: true }); try { const target = await pin(parsed.hostname, options.lookup ?? (async h => dnsLookup(h, { all: true, verbatim: true })), signal.signal); const lookup = (_h: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) => opts.all ? cb(null, [target]) : cb(null, target.address, target.family); socket = options.socket ? options.socket(parsed.toString(), lookup) : new WebSocket(parsed, { followRedirects: false, maxPayload: 1024 * 1024, handshakeTimeout: 15000, lookup: lookup as never }); socket.on('message', data => { try { const row = obj(JSON.parse(data.toString())); if (row) { queue.push(row); wake?.(); wake = undefined } } catch {} }); socketWait = new Promise<void>((resolve, reject) => { let settled = false; const finish = (error?: unknown) => { if (settled) return; settled = true; error ? reject(error) : resolve() }; socket!.once('open', () => finish()); socket!.once('error', () => finish(fail('transient'))); socket!.once('close', () => { finish(fail('transient')); socket = undefined; socketWait = undefined; wake?.(); wake = undefined }) }); try { await socketWait } catch (error) { socket?.terminate(); socket = undefined; throw error } } finally { lifecycle.signal.removeEventListener('abort', abort); op?.signal.removeEventListener('abort', abort) } }
 const next = async (op?: ExtensionChatOperationContext): Promise<Json | undefined> => { const deadline = Date.now() + 24000; while (!queue.length) { await op?.assertActive(); op?.signal.throwIfAborted(); const remaining = deadline - Date.now(); if (remaining <= 0) return undefined; await new Promise<void>((resolve, reject) => { let done = false; const finish = (error?: unknown) => { if (done) return; done = true; clearTimeout(timer); op?.signal.removeEventListener('abort', onAbort); if (wake === resolve) wake = undefined; error ? reject(error) : resolve() }; const onAbort = () => finish(fail('blocked')); const timer = setTimeout(finish, Math.min(250, remaining)); wake = () => finish(); op?.signal.addEventListener('abort', onAbort, { once: true }) }) } return queue.shift() }
 return {
  async identify(op) { const result = obj(await call('auth.test', {}, op)); const t = id(result?.team_id), b = id(result?.user_id); if (!t || !b) throw fail('blocked'); team = t; bot = b; username = String(result?.user ?? b); return { id: `${t}:${b}`, username, discoveryUrl: 'https://api.slack.com/apps' } },
  async inspect(chatId, op) { if (!team || !bot) await this.identify(op); const parsed = parseChat(chatId, team, bot); const value = await inspect(parsed.channel, op); if (value.id !== chatId) throw fail('blocked'); return value },
  async send(chatId, message: ChatMessage, op) { const parsed = parseChat(chatId, team, bot); if (!message.text || message.text.length > 4000 || (message.buttons?.flat().length ?? 0) > 25) throw fail('blocked'); const blocks = message.buttons?.length ? message.buttons.map((row: ChatButtonRow, ri: number) => ({ type: 'actions', elements: row.map((button: ChatButton, i: number) => ({ type: 'button', action_id: `cezar_${ri * 25 + i}`, text: { type: 'plain_text', text: button.text.slice(0, 75) }, value: button.data })) })) : undefined; const result = obj(await call('chat.postMessage', { channel: parsed.channel, text: escapeText(message.text), mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false, ...(blocks ? { blocks: [...textBlocks(message.text), ...blocks] } : {}), ...(message.replyTo ? { thread_ts: parseChat(message.replyTo.chatId, team, bot).channel === parsed.channel ? message.replyTo.messageId : (() => { throw fail('blocked') })() } : {}) }, op)); const channel = text(result?.channel), messageId = ts(result?.ts); if (channel !== parsed.channel || !messageId) throw fail('blocked'); return { chatId, messageId } },
  async clearButtons(receipt: ChatReceipt, op) { const parsed = parseChat(receipt.chatId, team, bot); const result = await call('chat.update', { channel: parsed.channel, ts: receipt.messageId, blocks: [] }, op); if (obj(result)?.channel && obj(result)?.channel !== parsed.channel) throw fail('blocked') },
  async acknowledge() {},
  async isMember(chatId, userId, op) { const parsed = parseChat(chatId, team, bot); if (!/^[A-Z0-9]+$/.test(userId)) return false; await this.inspect(chatId, op); let cursor: string | undefined; for (let page = 0; page < 20; page++) { const result = obj(await call('conversations.members', { channel: parsed.channel, limit: 200, ...(cursor ? { cursor } : {}) }, op)); const members = Array.isArray(result?.members) ? result.members : []; if (members.includes(userId)) return true; const meta = obj(result?.response_metadata); cursor = text(meta?.next_cursor, 256)?.trim() || undefined; if (!cursor) return false } return false },
  async receive(after, op): Promise<ExtensionChatBatch> { if (disposed) throw fail('blocked'); if (!team || !bot) await this.identify(op); if (after !== null && Number.isSafeInteger(after)) sequence = Math.max(sequence, after); if (!socket) await open(op); const raw = await next(op); if (!raw) return []; const envelopeId = text(raw.envelope_id, 128); if (envelopeId && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: envelopeId })); const resolved = await normalize(raw, team, bot, inspect, Date.now(), op); const n = ++sequence; return [{ sequence: n, ...(resolved ? { event: resolved } : {}) }] },
  async dispose() { disposed = true; lifecycle.abort(); wake?.(); wake = undefined; socket?.terminate(); socket = undefined; if (socketWait) await socketWait.catch(() => undefined) }
 }
}
