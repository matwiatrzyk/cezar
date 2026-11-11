import { validTelegramHtml } from './presentation.js'
import { pinPublicAddress, pinnedConnect, readCapped, type Lookup } from './pinned-request.js'
import {
  ExtensionChatError,
  type ChatSessionEvent,
  type ChatEvent,
  type ChatReceiveSession,
  type ChatMessage,
  type ChatReceipt,
  type ExtensionChatAdapter,
  type ExtensionChatOperationContext,
} from '@open-mercato/cezar-extension-sdk/chat'
import { lookup as dnsLookup } from 'node:dns/promises'
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

type TelegramRequestOptions = {
  lookup?: Lookup
  request?: typeof undiciRequest
}
const refuse = (kind: 'blocked' | 'transient') => new ExtensionChatError({ kind })
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
      const target = await pinPublicAddress('api.telegram.org', options.lookup ?? (async hostname => dnsLookup(hostname, { all: true, verbatim: true })), controller.signal, deadline, refuse)
      dispatcher = new Agent({ connections: 1, pipelining: 1, connect: pinnedConnect(target) })
      await operation?.assertActive()
      const response = await (options.request ?? undiciRequest)(`https://api.telegram.org/bot${token}/${method}`, {
        dispatcher, method: 'POST', headersTimeout: deadline, bodyTimeout: deadline,
        headers: { 'content-type': 'application/json', 'user-agent': 'cezar-telegram-extension/0.1' },
        body: JSON.stringify(body), signal: controller.signal,
      })
      const received = await readCapped(response.body, refuse)
      let envelope: Json | undefined
      try { envelope = object(JSON.parse(received.toString('utf8'))) } catch { /* handled below */ }
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
  if (!row || !chatId || !['private', 'group', 'supergroup'].includes(String(type))) return
  return { id: chatId, kind: type === 'private' ? 'private' as const : 'group' as const, title: text(row.title, 256) }
}

function normalize(update: unknown, username: string): { sequence: number; event?: ChatSessionEvent } | undefined {
  const row = object(update)
  if (!row || !integer(row.update_id) || (row.update_id as number) < 0) return
  const sequence = row.update_id as number
  const member = object(row.my_chat_member)
  if (member) {
    const target = chat(member.chat), next = object(member.new_chat_member)
    if (target && (next?.status === 'left' || next?.status === 'kicked' || object(member.chat)?.is_forum === true)) {
      return { sequence, event: { kind: 'membership', id: `update:${sequence}`, chat: { id: target.id, kind: target.kind }, reason: 'removed' } }
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
    if (target && user && messageId && body !== undefined && object(message.chat)?.is_forum !== true
      && ['forward_origin','via_bot','sender_chat','photo','document','video','audio','voice','sticker','animation'].every(key => message[key] === undefined)
      && message.message_thread_id === undefined && message.is_topic_message !== true) {
      const entity = Array.isArray(message.entities) ? message.entities.map(object).find(item => item?.type === 'bot_command' && item.offset === 0 && integer(item.length)) : undefined
      const token = entity ? body.slice(0, entity.length as number) : ''
      const addressed = token.toLowerCase().endsWith(`@${username.toLowerCase()}`)
      const match = /^\/([a-zA-Z0-9_]{1,32})(?:@([a-zA-Z0-9_]{1,64}))?$/.exec(token)
      const commands = ['start','task','tasks','status','reply','cancel','continue','help'] as const
      let command: NonNullable<Extract<ChatSessionEvent,{kind:'message'}>['command']> = {kind:body.startsWith('/') ? 'unknown' : 'text'}
      if (entity && match && (body.length === token.length || /\s/.test(body[token.length]!))) {
        const name = match[1]!.toLowerCase() as typeof commands[number]
        command = match[2] && match[2].toLowerCase() !== username.toLowerCase() ? {kind:'ignore'}
          : commands.includes(name) ? {kind:'command',name,args:body.slice(token.length).trim()} : {kind:'unknown'}
      }
      const reply = object(message.reply_to_message), replyId = id(reply?.message_id)
      return { sequence, event: { kind: 'message', id: `update:${sequence}`, messageId, chat: { id: target.id, kind: target.kind }, user, at: Number(message.date) * 1000,
        text: body, addressed, command, ...(target.title ? {title:target.title} : {}), pairingEligible: target.kind !== 'private' || user.id === target.id,
        ...(replyId ? { replyTo: { chatId: target.id, messageId: replyId } } : {}) } }
    }
  }
  const callback = object(row.callback_query), callbackMessage = object(callback?.message)
  if (callback && callbackMessage) {
    const target = chat(callbackMessage.chat), user = actor(callback.from), messageId = id(callbackMessage.message_id)
    const callbackId = text(callback.id, 128), data = text(callback.data, 128)
    if (target && object(callbackMessage.chat)?.is_forum !== true && user && messageId && callbackId && data) return { sequence, event: { kind: 'button', id: callbackId, chat: { id: target.id, kind: target.kind }, user,
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
      // Plain text is the default. Explicit formatting accepts only the bounded
      // safe subset used by host renderers, never arbitrary Telegram entities.
      if (!message.text || message.text.length > 4096 || (message.textFormat && message.textFormat !== 'plain' && message.textFormat !== 'telegram-html') || (message.textFormat === 'telegram-html' && !validTelegramHtml(message.text))) throw new ExtensionChatError({ kind: 'blocked' })
      const replyId = message.replyTo ? Number(message.replyTo.messageId) : undefined
      if (message.replyTo && (message.replyTo.chatId !== chatId || !Number.isSafeInteger(replyId) || replyId! <= 0)) throw new ExtensionChatError({ kind: 'blocked' })
      const result = object(await invoke('sendMessage', { chat_id: chatId, text: message.text, ...(message.textFormat === 'telegram-html' ? { parse_mode: 'HTML' } : {}), link_preview_options: { is_disabled: true },
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
    async receiveSession(session: ChatReceiveSession) {
      if (!username) await this.identify(session)
      while (!session.signal.aborted) {
        const checkpoint = await session.checkpoint()
        const result = await invoke('getUpdates', { timeout:25, limit:50, allowed_updates:['message','callback_query','my_chat_member'], ...(checkpoint.nextSequence === null ? {} : {offset:checkpoint.nextSequence}) }, session)
        if (!Array.isArray(result) || result.length > 50) throw new ExtensionChatError({kind:'blocked'})
        const rows = result.map(item => normalize(item, username))
        if (rows.some((row,index) => !row || row.sequence >= Number.MAX_SAFE_INTEGER || (index > 0 && row.sequence <= rows[index-1]!.sequence))) throw new ExtensionChatError({kind:'blocked'})
        for (const row of rows) await session.accept({kind:'ordered',epoch:checkpoint.epoch,sequence:row!.sequence,...(row!.event ? {event:row!.event} : {})})
        await session.health({state:'polling'})
      }
    },
  }
}
