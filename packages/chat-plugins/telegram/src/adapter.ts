import {
  ExtensionChatError,
  type ChatEvent,
  type ChatMessage,
  type ChatReceipt,
  type ExtensionChatAdapter,
  type ExtensionChatBatch,
  type ExtensionChatOperationContext,
} from '@open-mercato/cezar-extension-sdk/chat'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Agent, request as undiciRequest } from 'undici'

type Json = Record<string, unknown>
type Request = (method: string, body: Json, operation?: ExtensionChatOperationContext) => Promise<unknown>

const integer = (value: unknown): value is number => Number.isSafeInteger(value)
const object = (value: unknown): Json | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : undefined
const id = (value: unknown) => integer(value) && value !== 0 ? String(value) : undefined
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : undefined

function failure(status: number, retryAfter?: number): ExtensionChatError {
  if (status === 401) return new ExtensionChatError({ kind: 'auth' })
  if (status === 409) return new ExtensionChatError({ kind: 'conflict' })
  if (status === 429) return new ExtensionChatError({ kind: 'rate_limited', retryAfterMs: Math.max(1000, (retryAfter ?? 5) * 1000) })
  if (status === 403) return new ExtensionChatError({ kind: 'gone' })
  return new ExtensionChatError({ kind: status >= 500 ? 'transient' : 'blocked' })
}

type Address = { address: string; family: number }
type TelegramRequestOptions = {
  lookup?: (hostname: string) => Promise<Address[]>
  request?: typeof undiciRequest
}
const MAX_RESPONSE_BYTES = 1024 * 1024
function untilAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
type AddressClass = 'public' | 'private' | 'denied'
const v4 = (address: string) => address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0)
const in4 = (address: number, network: string, bits: number) => Math.floor(address / 2 ** (32 - bits)) === Math.floor(v4(network) / 2 ** (32 - bits))
function classify4(address: string): AddressClass {
  const value = v4(address)
  if ([['0.0.0.0', 8], ['100.64.0.0', 10], ['169.254.0.0', 16], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]].some(([network, bits]) => in4(value, network as string, bits as number))) return 'denied'
  if ([['10.0.0.0', 8], ['127.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]].some(([network, bits]) => in4(value, network as string, bits as number))) return 'private'
  return 'public'
}
function ipv6(address: string): bigint {
  let value = address.toLowerCase()
  if (value.includes('.')) {
    const colon = value.lastIndexOf(':'); const tail = v4(value.slice(colon + 1))
    value = value.slice(0, colon + 1) + Math.floor(tail / 65536).toString(16) + ':' + (tail % 65536).toString(16)
  }
  const [left = '', right] = value.split('::')
  const a = left ? left.split(':') : []; const b = right ? right.split(':') : []
  const words = right === undefined ? a : [...a, ...Array<string>(8 - a.length - b.length).fill('0'), ...b]
  return words.reduce((result, word) => (result << 16n) + BigInt(`0x${word}`), 0n)
}
const in6 = (address: bigint, network: string, bits: number) => (address >> BigInt(128 - bits)) === (ipv6(network) >> BigInt(128 - bits))
function classifyAddress(input: string): AddressClass {
  const address = input.replace(/^\[|\]$/g, '')
  if (address.includes('%')) return 'denied'
  if (isIP(address) === 4) return classify4(address)
  if (isIP(address) !== 6) return 'denied'
  const value = ipv6(address)
  if (value === 0n || value === ipv6('fd00:ec2::254')) return 'denied'
  if (value === 1n) return 'private'
  if (in6(value, '::ffff:0:0', 96) || in6(value, '::', 96)) {
    const embedded = Number(value & 0xffffffffn)
    return classify4([24, 16, 8, 0].map(shift => (embedded >>> shift) & 255).join('.'))
  }
  if (in6(value, 'fc00::', 7)) return 'private'
  if (!in6(value, '2000::', 3) || in6(value, '2001::', 23) || in6(value, '2001:db8::', 32) || in6(value, '2002::', 16) || in6(value, '3fff::', 20)) return 'denied'
  return 'public'
}

/** Fixed Telegram host, public-address validation plus DNS pinning, whole-operation deadlines and
 * a streamed response cap. Tests may inject DNS and wire I/O without weakening production. */
export function telegramRequest(token: string, options: TelegramRequestOptions = {}): Request {
  if (!/^\d{6,20}:[A-Za-z0-9_-]{20,128}$/.test(token)) throw new Error('Invalid Telegram bot token')
  return async (method, body, operation) => {
    await operation?.assertActive()
    operation?.signal.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort()
    operation?.signal.addEventListener('abort', abort, { once: true })
    const deadline = method === 'getUpdates' ? 35_000 : 10_000
    const timer = setTimeout(abort, deadline)
    let dispatcher: Agent | undefined
    try {
      const addresses = await untilAbort((options.lookup ?? (async hostname => dnsLookup(hostname, { all: true, verbatim: true })))('api.telegram.org'), controller.signal)
      const classes = addresses.map(item => classifyAddress(item.address))
      const target = addresses.find((item, index) => classes[index] === 'public' && item.family === isIP(item.address))
      if (!target || addresses.some((item, index) => classes[index] !== 'public' || item.family !== isIP(item.address))) throw new ExtensionChatError({ kind: 'blocked' })
      dispatcher = new Agent({ connections: 1, pipelining: 1, connect: { rejectUnauthorized: true, autoSelectFamily: false,
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions.all) callback(null, [target])
          else callback(null, target.address, target.family)
        } } })
      await operation?.assertActive()
      const response = await (options.request ?? undiciRequest)(`https://api.telegram.org/bot${token}/${method}`, {
        dispatcher, method: 'POST', headersTimeout: deadline, bodyTimeout: deadline,
        headers: { 'content-type': 'application/json', 'user-agent': 'cezar-telegram-extension/0.1' },
        body: JSON.stringify(body), signal: controller.signal,
      })
      const chunks: Buffer[] = []; let length = 0
      try {
        for await (const chunk of response.body) {
          length += chunk.length
          if (length > MAX_RESPONSE_BYTES) throw new ExtensionChatError({ kind: 'blocked' })
          chunks.push(Buffer.from(chunk))
        }
      } finally { response.body.destroy() }
      let envelope: Json | undefined
      try { envelope = object(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { /* handled below */ }
      if (response.statusCode !== 200 || envelope?.ok !== true) {
        const parameters = object(envelope?.parameters)
        throw failure(response.statusCode, integer(parameters?.retry_after) ? parameters.retry_after as number : undefined)
      }
      return envelope.result
    } catch (error) {
      if (error instanceof ExtensionChatError) throw error
      if (operation?.signal.aborted || controller.signal.aborted) throw new ExtensionChatError({ kind: 'blocked' })
      throw new ExtensionChatError({ kind: 'transient' })
    } finally {
      clearTimeout(timer)
      operation?.signal.removeEventListener('abort', abort)
      await dispatcher?.close().catch(() => undefined)
    }
  }
}

function actor(value: unknown) {
  const row = object(value), actorId = id(row?.id)
  if (!row || !actorId || row.is_bot !== false) return
  const first = text(row.first_name, 256) ?? '', last = text(row.last_name, 256) ?? ''
  return { id: actorId, label: `${first} ${last}`.trim().slice(0, 256), ...(text(row.username, 128) ? { username: row.username as string } : {}) }
}

function chat(value: unknown) {
  const row = object(value), chatId = id(row?.id), type = row?.type
  if (!row || !chatId || !['private', 'group', 'supergroup'].includes(String(type)) || row.is_forum === true) return
  return { id: chatId, kind: type === 'private' ? 'private' as const : 'group' as const, title: text(row.title, 256) }
}

function normalize(update: unknown, username: string): { sequence: number; event?: ChatEvent } | undefined {
  const row = object(update)
  if (!row || !integer(row.update_id) || (row.update_id as number) < 0) return
  const sequence = row.update_id as number
  const member = object(row.my_chat_member)
  if (member) {
    const target = chat(member.chat), next = object(member.new_chat_member)
    if (target && (next?.status === 'left' || next?.status === 'kicked')) {
      return { sequence, event: { kind: 'membership', id: `update:${sequence}`, chat: target, reason: 'removed' } }
    }
  }
  const message = object(row.message)
  if (message) {
    const target = chat(message.chat), user = actor(message.from), messageId = id(message.message_id)
    const migratedTo = id(message.migrate_to_chat_id), migratedFrom = id(message.migrate_from_chat_id)
    if (target && (migratedTo || migratedFrom)) {
      const current = migratedTo ?? target.id, previous = migratedFrom ?? target.id
      return { sequence, event: { kind: 'membership', id: `update:${sequence}`, chat: { id: current, kind: 'group' }, reason: 'migrated', previousChatId: previous } }
    }
    const body = text(message.text, 65536)
    if (target && user && messageId && body !== undefined && !message.forward_origin && !message.via_bot && !message.sender_chat
      && message.message_thread_id === undefined && message.is_topic_message !== true) {
      const entity = Array.isArray(message.entities) ? message.entities.map(object).find(item => item?.type === 'bot_command' && item.offset === 0 && integer(item.length)) : undefined
      const token = entity ? body.slice(0, entity.length as number) : ''
      const addressed = target.kind === 'private' || token.toLowerCase().endsWith(`@${username.toLowerCase()}`)
      const stripped = target.kind === 'group' && addressed ? body.replace(/^\/([A-Za-z0-9_]+)@[A-Za-z0-9_]+/, '/$1') : body
      const start = /^\/start\s+([A-Za-z0-9_-]{1,128})$/.exec(stripped)
      if (start && addressed) return { sequence, event: { kind: 'start', id: `update:${sequence}`, chat: target, user, at: Number(message.date) * 1000, code: start[1]!, ...(target.title ? { title: target.title } : {}) } }
      const reply = object(message.reply_to_message), replyId = id(reply?.message_id)
      return { sequence, event: { kind: 'message', id: `update:${sequence}`, messageId, chat: target, user, at: Number(message.date) * 1000,
        text: stripped, addressed, pairingEligible: target.kind !== 'private' || user.id === target.id,
        ...(replyId ? { replyTo: { chatId: target.id, messageId: replyId } } : {}) } }
    }
  }
  const callback = object(row.callback_query), callbackMessage = object(callback?.message)
  if (callback && callbackMessage) {
    const target = chat(callbackMessage.chat), user = actor(callback.from), messageId = id(callbackMessage.message_id)
    const callbackId = text(callback.id, 128), data = text(callback.data, 128)
    if (target && user && messageId && callbackId && data) return { sequence, event: { kind: 'button', id: callbackId, chat: target, user,
      receipt: { chatId: target.id, messageId }, data } }
  }
  return { sequence }
}

export function createTelegramAdapter(request: Request): ExtensionChatAdapter {
  let username = ''
  const invoke = async (method: string, body: Json, operation?: ExtensionChatOperationContext) => request(method, body, operation)
  return {
    async identify(operation) {
      const me = object(await invoke('getMe', {}, operation)), botId = id(me?.id), name = text(me?.username, 64)
      if (!botId || !name) throw new ExtensionChatError({ kind: 'blocked' })
      username = name
      return { id: botId, username: name, discoveryUrl: `https://t.me/${name}` }
    },
    async inspect(chatId, operation) {
      const parsed = chat(await invoke('getChat', { chat_id: chatId }, operation))
      return parsed ? { id: parsed.id, kind: parsed.kind, eligible: true } : { id: chatId, kind: 'group', eligible: false }
    },
    async send(chatId, message: ChatMessage, operation) {
      // Public ChatMessage.text is untrusted plain text, never Telegram HTML.
      if (!message.text || message.text.length > 4096) throw new ExtensionChatError({ kind: 'blocked' })
      const replyId = message.replyTo ? Number(message.replyTo.messageId) : undefined
      if (message.replyTo && (message.replyTo.chatId !== chatId || !Number.isSafeInteger(replyId) || replyId! <= 0)) throw new ExtensionChatError({ kind: 'blocked' })
      const result = object(await invoke('sendMessage', { chat_id: chatId, text: message.text, link_preview_options: { is_disabled: true },
        ...(replyId === undefined ? {} : { reply_parameters: { message_id: replyId } }),
        ...(message.buttons ? { reply_markup: { inline_keyboard: message.buttons.map(row => row.map(button => ({ text: button.text, callback_data: button.data }))) } } : {}) }, operation))
      const resultChat = object(result?.chat), messageId = id(result?.message_id), resultChatId = id(resultChat?.id)
      if (!messageId || !resultChatId) throw new ExtensionChatError({ kind: 'blocked' })
      return { messageId, chatId: resultChatId }
    },
    async clearButtons(receipt: ChatReceipt, operation) { await invoke('editMessageReplyMarkup', { chat_id: receipt.chatId, message_id: Number(receipt.messageId), reply_markup: { inline_keyboard: [] } }, operation) },
    async acknowledge(eventId, answer, operation) { await invoke('answerCallbackQuery', { callback_query_id: eventId, text: answer }, operation) },
    async isMember(chatId, userId, operation) {
      try {
        const result = object(await invoke('getChatMember', { chat_id: chatId, user_id: Number(userId) }, operation))
        return id(object(result?.user)?.id) === userId && !['left', 'kicked'].includes(String(result?.status))
      } catch (error) { if (error instanceof ExtensionChatError && error.failure.kind === 'blocked') return false; throw error }
    },
    async receive(after, operation): Promise<ExtensionChatBatch> {
      if (!username) await this.identify(operation)
      const result = await invoke('getUpdates', { timeout: 25, limit: 50, allowed_updates: ['message', 'callback_query', 'my_chat_member'], ...(after === null ? {} : { offset: after + 1 }) }, operation)
      if (!Array.isArray(result) || result.length > 50) throw new ExtensionChatError({ kind: 'blocked' })
      const rows = result.map(item => normalize(item, username))
      if (rows.some(item => !item)) throw new ExtensionChatError({ kind: 'blocked' })
      const batch = rows as ExtensionChatBatch
      if (batch.some((item, index) => index > 0 && item.sequence <= batch[index - 1]!.sequence)) throw new ExtensionChatError({ kind: 'blocked' })
      return batch
    },
  }
}
