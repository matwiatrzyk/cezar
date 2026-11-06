import { eligibleText, parseCommand, type TelegramUpdate, type TelegramMessage } from './protocol.ts';
import type { InputMessage, InputUpdate } from '../../events.ts';
export function normalizeMessage(message: TelegramMessage, username: string): InputMessage | undefined {
  if (!eligibleText(message, true)) return undefined;
  const user = message.from!;
  const token = message.text!.slice(0, message.entities?.find(entity => entity.type === 'bot_command' && entity.offset === 0)?.length ?? 0);
  return { id: String(message.message_id), at: message.date * 1000,
    chat: { id: String(message.chat.id), kind: message.chat.type === 'private' ? 'private' : 'group', ...(message.chat.title ? { title: message.chat.title } : {}) },
    user: { id: String(user.id), label: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 256), ...(user.username ? { username: user.username } : {}) },
    pairingEligible: message.chat.type !== 'private' || message.from?.id === message.chat.id, text: message.text!, command: parseCommand(message, username), addressed: token.toLowerCase().endsWith(`@${username.toLowerCase()}`),
    ...(message.reply_to_message ? { replyTo: String(message.reply_to_message.message_id) } : {}) };
}
export function normalizeUpdate(update: TelegramUpdate, username: string): InputUpdate {
  const message = update.message && normalizeMessage(update.message, username);
  const callback = update.callback_query;
  const member = update.my_chat_member, raw = update.message;
  const migration = raw?.migrate_to_chat_id !== undefined || raw?.migrate_from_chat_id !== undefined;
  const affected = new Set<string>();
  if (migration && raw) { affected.add(String(raw.chat.id)); if (raw.migrate_from_chat_id !== undefined) affected.add(String(raw.migrate_from_chat_id)); }
  if (member && (['left','kicked'].includes(member.new_chat_member.status) || member.chat.is_forum)) affected.add(String(member.chat.id));
  return { sequence: update.update_id, ...(message ? { message } : {}),
    ...(callback?.message && !callback.from.is_bot && !callback.message.chat.is_forum ? { button: { id: callback.id, userId: String(callback.from.id), chatId: String(callback.message.chat.id), messageId: String(callback.message.message_id), ...(callback.data ? { data: callback.data } : {}) } } : {}),
    ...(member || migration ? { membership: { affected: [...affected], reason: migration ? 'group_migrated' as const : 'bot_removed' as const } } : {}) };
}
