import { ExtensionChatError, type ChatMessage, type ChatReceipt, type ExtensionChatAdapter, type ExtensionChatBatch, type ExtensionChatOperationContext } from '@open-mercato/cezar-extension-sdk/chat'
import { request as undiciRequest, Agent } from 'undici'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import WebSocket from 'ws'

type Json = Record<string, unknown>
type Credentials = { appToken: string; botToken: string }
type Address = { address: string; family: number }
const id = (v: unknown) => typeof v === 'string' && /^[A-Z0-9]+$/.test(v) ? v : undefined
const ts = (v: unknown) => typeof v === 'string' && /^\d{10,16}\.\d{6}$/.test(v) ? v : undefined
const obj = (v: unknown): Json | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : undefined
const text = (v: unknown, max = 65536) => typeof v === 'string' && v.length <= max ? v : undefined
const fail = (kind: 'auth'|'conflict'|'rate_limited'|'gone'|'transient'|'blocked', retryAfterMs?: number) => new ExtensionChatError({ kind, ...(retryAfterMs ? { retryAfterMs } : {}) })

function assertCredentials(c: Credentials) {
  if (!/^xapp-[A-Za-z0-9-]{10,}$/.test(c.appToken) || !/^xoxb-[A-Za-z0-9-]{10,}$/.test(c.botToken)) throw fail('auth')
}

function classify(address: string) {
  const value = address.replace(/^\[|\]$/g, '')
  if (isIP(value) !== 4 && isIP(value) !== 6) return false
  if (value === '127.0.0.1' || value === '::1' || value.startsWith('10.') || value.startsWith('192.168.')) return false
  return true
}

export type SlackRequestOptions = { lookup?: (hostname: string) => Promise<Address[]>; request?: typeof undiciRequest }
export function slackRequest(credentials: Credentials, options: SlackRequestOptions = {}) {
  assertCredentials(credentials)
  return async (method: string, body: Json, operation?: ExtensionChatOperationContext): Promise<unknown> => {
    await operation?.assertActive(); operation?.signal.throwIfAborted()
    const controller = new AbortController(); const abort = () => controller.abort(); operation?.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, method === 'apps.connections.open' ? 15000 : 10000); let dispatcher: Agent | undefined
    try {
      const addresses = await (options.lookup ?? (async host => dnsLookup(host, { all: true, verbatim: true })))('slack.com')
      const target = addresses.find(item => classify(item.address) && item.family === isIP(item.address))
      if (!target || addresses.some(item => !classify(item.address))) throw fail('blocked')
      dispatcher = new Agent({ connections: 1, pipelining: 1, connect: { rejectUnauthorized: true, autoSelectFamily: false, lookup(_h, opts, cb) { if (opts.all) cb(null, [target!]); else cb(null, target!.address, target!.family) } } })
      const form = new URLSearchParams(); for (const [key, value] of Object.entries(body)) if (value !== undefined) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
      const response = await (options.request ?? undiciRequest)(`https://slack.com/api/${method}`, { dispatcher, method: 'POST', signal: controller.signal, headersTimeout: 10000, bodyTimeout: 10000, headers: { authorization: `Bearer ${method === 'apps.connections.open' ? credentials.appToken : credentials.botToken}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() })
      const chunks: Buffer[] = []; let length = 0; for await (const chunk of response.body) { length += chunk.length; if (length > 1024 * 1024) throw fail('blocked'); chunks.push(Buffer.from(chunk)) }
      const result = obj(JSON.parse(Buffer.concat(chunks).toString('utf8'))); if (response.statusCode === 429) throw fail('rate_limited', 5000); if (response.statusCode === 401) throw fail('auth'); if (response.statusCode >= 500) throw fail('transient'); if (result?.ok !== true) { const error = result?.error; throw fail(error === 'too_many_connections' ? 'conflict' : ['channel_not_found', 'not_in_channel', 'is_archived'].includes(String(error)) ? 'gone' : ['invalid_auth', 'token_revoked', 'token_expired'].includes(String(error)) ? 'auth' : 'blocked') } return result
    } catch (error) { if (error instanceof ExtensionChatError) throw error; if (operation?.signal.aborted || controller.signal.aborted) throw fail('blocked'); throw fail('transient') } finally { clearTimeout(timer); operation?.signal.removeEventListener('abort', abort); await dispatcher?.close().catch(() => undefined) }
  }
}

function chat(team: string, bot: string, channel: string, kind: 'private'|'group') { return { id: `${kind}:${team}:${bot}:${channel}`, kind } as const }
function normalize(raw: Json, team: string, bot: string, inspect: (channel: string, op?: ExtensionChatOperationContext) => Promise<{ id: string; kind: 'private'|'group'; eligible: boolean }>, now: number, op?: ExtensionChatOperationContext) {
  const envelope = obj(raw); if (!envelope || envelope.type !== 'events_api') return undefined; const payload = obj(envelope.payload); const event = obj(payload?.event); if (!payload || !event || payload.team_id !== team || event.bot_id || event.user === bot) return undefined
  const channel = id(event.channel), user = id(event.user), stamp = ts(event.ts); if (!channel || !user || !stamp || event.subtype) return undefined; const when = Number(stamp) * 1000; if (when < now - 15 * 60_000 || when > now + 60_000) return undefined
  return inspect(channel, op).then(ref => { if (!ref.eligible) return undefined; const mention = `<@${bot}>`; const addressed = ref.kind === 'private' || String(event.text ?? '').includes(mention); if (ref.kind === 'group' && !addressed && event.thread_ts === undefined) return undefined; const body = text(event.text); if (body === undefined) return undefined; const clean = body.replaceAll(mention, '').trim().replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&'); const thread = ts(event.thread_ts); const base = { id: `msg:${channel}:${stamp}`, chat: ref, user: { id: user, label: user }, at: when, text: clean, addressed, messageId: stamp, ...(thread ? { replyTo: { chatId: ref.id, messageId: thread } } : {}) }; return { kind: 'message' as const, ...base } })
}

export function createSlackAdapter(credentials: Record<string, string>, request = slackRequest(credentials as Credentials)): ExtensionChatAdapter {
  const c = credentials as Credentials; assertCredentials(c); let team = '', bot = '', username = ''; let cursor: string | undefined; const queue: Json[] = []; let socket: WebSocket | undefined
  const call = (method: string, body: Json, op?: ExtensionChatOperationContext) => request(method, body, op)
  const inspect = async (channel: string, op?: ExtensionChatOperationContext) => { const result = obj(await call('conversations.info', { channel }, op)); const row = obj(result?.channel); if (!row || row.id !== channel) return { id: channel, kind: 'group' as const, eligible: false }; const kind = row.is_im === true && row.is_mpim !== true ? 'private' as const : 'group' as const; return { id: chat(team, bot, channel, kind).id, kind, eligible: row.is_archived !== true && (kind === 'private' || row.is_member === true) } }
  return {
    async identify(op) { const result = obj(await call('auth.test', {}, op)); const t = id(result?.team_id), b = id(result?.user_id); if (!t || !b) throw fail('blocked'); team = t; bot = b; username = String(result?.user ?? b); return { id: `${t}:${b}`, username, discoveryUrl: 'https://api.slack.com/apps' } },
    async inspect(chatId, op) { if (!team || !bot) await this.identify(op); const value = await inspect(chatId.split(':').at(-1)!, op); if (value.id !== chatId) throw fail('blocked'); return value },
    async send(chatId, message: ChatMessage, op) { const ref = chat(chatId.split(':')[1]!, chatId.split(':')[2]!, chatId.split(':').at(-1)!, chatId.startsWith('private:') ? 'private' : 'group'); if (!message.text || message.text.length > 4000 || (message.buttons?.flat().length ?? 0) > 25) throw fail('blocked'); const result = obj(await call('chat.postMessage', { channel: ref.id.split(':').at(-1), text: message.text, mrkdwn: true, parse: 'none', unfurl_links: false, unfurl_media: false, ...(message.replyTo ? { thread_ts: message.replyTo.messageId } : {}) }, op)); const channel = text(result?.channel), messageId = ts(result?.ts); if (channel !== ref.id.split(':').at(-1) || !messageId) throw fail('blocked'); return { chatId, messageId } },
    async clearButtons(receipt: ChatReceipt, op) { await call('chat.update', { channel: receipt.chatId.split(':').at(-1), ts: receipt.messageId, blocks: [] }, op) },
    async acknowledge() {},
    async isMember(chatId, userId, op) { const ref = await this.inspect(chatId, op); if (!ref.eligible) return false; const result = obj(await call('conversations.members', { channel: chatId.split(':').at(-1), limit: 200 }, op)); const members = Array.isArray(result?.members) ? result.members : []; return members.includes(userId) },
    async receive(after, op): Promise<ExtensionChatBatch> { if (!team || !bot) await this.identify(op); if (!socket) { const opened = obj(await call('apps.connections.open', {}, op)); const url = text(opened?.url); let parsed: URL | undefined; try { parsed = url ? new URL(url) : undefined } catch {} if (!parsed || parsed.protocol !== 'wss:' || !parsed.hostname.endsWith('.slack.com') || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) throw fail('blocked'); socket = new WebSocket(parsed, { followRedirects: false, maxPayload: 1024 * 1024 }); socket.on('message', data => { try { const row = obj(JSON.parse(data.toString())); if (row) queue.push(row); } catch {} }); await new Promise<void>((resolve, reject) => { socket!.once('open', () => resolve()); socket!.once('error', reject) }) }
      while (!queue.length) await new Promise(resolve => setTimeout(resolve, 20)); const raw = queue.shift()!; const envelope = obj(raw); if (envelope?.envelope_id && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ envelope_id: envelope.envelope_id })); const event = await normalize(raw, team, bot, inspect, Date.now(), op); const sequence = typeof envelope?.event_id === 'string' ? envelope.event_id : `${after === null ? 0 : after + 1}`; const n = Number.parseInt(sequence.replace(/\D/g, '').slice(-15), 10); return [{ sequence: Number.isSafeInteger(n) ? n : (after ?? -1) + 1, ...(event ? { event } : {}) }] },
    async dispose() { socket?.close(); socket = undefined }
  }
}
