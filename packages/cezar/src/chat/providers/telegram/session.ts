import { z } from 'zod';
import { ChatTransportError, type ChatSession, type ChatFailure } from '../../provider.ts';
import { TelegramApiError, type TelegramCall } from './client.ts';

const identity = z.object({ id: z.number().int().positive().safe(), username: z.string().regex(/^[A-Za-z0-9_]{1,64}$/) });
const receipt = z.object({ message_id: z.number().int().positive().safe(), chat: z.object({ id: z.number().int().safe() }) });
const membership = z.object({ user: z.object({ id: z.number().int().positive().safe() }), status: z.enum(['creator', 'administrator', 'member', 'restricted', 'left', 'kicked']), is_member: z.boolean().optional() });
export function telegramFailure(error: unknown): ChatFailure {
  if (!(error instanceof TelegramApiError)) return { kind: 'blocked' };
  if (error.status === 401) return { kind: 'auth' };
  if (error.status === 409) return { kind: 'conflict' };
  if (error.status === 429) return { kind: 'rate_limited', retryAfterMs: (error.retryAfter ?? 5) * 1000 };
  if (error.status === 403) return { kind: 'gone' };
  return { kind: error.code === 'network' || error.code === 'dns_not_found' || (error.status ?? 0) >= 500 ? 'transient' : 'blocked' };
}
/** The adapter alone sees Telegram method names, numeric IDs, markup and HTTP status codes. */
export function telegramSession(call: TelegramCall): ChatSession {
  const invoke = async (method: Parameters<TelegramCall>[0], body: object, signal?: AbortSignal, valid?: () => boolean) => {
    try { return await (valid ? call(method, body, signal, { valid }) : signal ? call(method, body, signal) : call(method, body)); }
    catch (error) { throw new ChatTransportError(telegramFailure(error)); }
  };
  return {
    async identify(signal) { const me = identity.parse(await invoke('getMe', {}, signal)); return { id: String(me.id), username: me.username }; },
    async send(chatId, message, signal, valid) {
      const result = receipt.parse(await invoke('sendMessage', { chat_id: chatId, text: message.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
        ...(message.buttons ? { reply_markup: { inline_keyboard: message.buttons.map(row => row.map(button => ({ text: button.text, callback_data: button.data }))) } } : {}) }, signal, valid));
      return { messageId: String(result.message_id), chatId: String(result.chat.id) };
    },
    async acknowledge(eventId, text, signal) { await invoke('answerCallbackQuery', { callback_query_id: eventId, text }, signal); },
    async clearButtons(receipt, signal) { await invoke('editMessageReplyMarkup', { chat_id: receipt.chatId, message_id: Number(receipt.messageId), reply_markup: { inline_keyboard: [] } }, signal); },
    async isMember(chatId, userId, signal) {
      try {
        const parsed = membership.safeParse(await (signal ? call('getChatMember', { chat_id: chatId, user_id: Number(userId) }, signal) : call('getChatMember', { chat_id: chatId, user_id: Number(userId) })));
        if (!parsed.success || String(parsed.data.user.id) !== userId) return undefined;
        return !['left', 'kicked'].includes(parsed.data.status) && (parsed.data.status !== 'restricted' || parsed.data.is_member === true);
      } catch (error) { return error instanceof TelegramApiError && error.code === 'http' && error.status === 400 ? false : undefined; }
    },
  };
}
