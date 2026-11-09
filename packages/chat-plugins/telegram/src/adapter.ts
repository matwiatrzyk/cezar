import {
  ExtensionChatError,
  type ChatEvent,
  type ChatMessage,
  type ChatReceipt,
  type ExtensionChatAdapter,
  type ExtensionChatBatch,
  type ExtensionChatOperationContext,
} from '@open-mercato/cezar-extension-sdk/chat'

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

/** Fixed-host production client. Tests inject the same adapter's Request against a loopback simulator. */
export function telegramRequest(token: string, fetcher: typeof fetch = fetch): Request {
  if (!/^\d{6,20}:[A-Za-z0-9_-]{20,128}$/.test(token)) throw new Error('Invalid Telegram bot token')
  return async (method, body, operation) => {
    await operation?.assertActive()
    operation?.signal.throwIfAborted()
    let response: Response
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'user-agent': 'cezar-telegram-extension/0.1' },
        body: JSON.stringify(body), signal: operation?.signal as AbortSignal | undefined,
      })
    } catch (error) {
      if (operation?.signal.aborted) throw new ExtensionChatError({ kind: 'blocked' })
      throw new ExtensionChatError({ kind: 'transient' })
    }
    const raw = await response.text()
    if (raw.length > 1024 * 1024) throw new ExtensionChatError({ kind: 'blocked' })
    let envelope: Json | undefined
    try { envelope = object(JSON.parse(raw)) } catch { /* handled below */ }
    if (!response.ok || envelope?.ok !== true) {
      const parameters = object(envelope?.parameters)
      throw failure(response.status, integer(parameters?.retry_after) ? parameters.retry_after as number : undefined)
    }
    return envelope.result
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
        text: stripped, addressed, ...(replyId ? { replyTo: { chatId: target.id, messageId: replyId } } : {}) } }
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
      const result = object(await invoke('sendMessage', { chat_id: chatId, text: message.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
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
