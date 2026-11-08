import { z } from 'zod';
import { telegramToken } from '../../../webhooks/telegram-secrets.ts';
import { ChatTransportError, type ChatTransport, type ChatServiceDescriptor } from '../../provider.ts';
import { telegramProvider } from './index.ts';
import { telegramPresentation } from './presentation.ts';
import { telegramSession, telegramFailure } from './session.ts';
import { TelegramPoller } from './poller.ts';
import { normalizeUpdate } from './normalize.ts';
import { TELEGRAM_COMMANDS } from './protocol.ts';
import type { TelegramCall } from './client.ts';
const chatSchema = z.object({ id: z.number().int().safe(), type: z.enum(['private', 'group', 'supergroup', 'channel']), is_forum: z.boolean().optional() });
export const telegramServiceDescriptor: ChatServiceDescriptor = {
 ...telegramProvider, format: 'telegram.v1', presentation: telegramPresentation,
 destination: credential => `https://api.telegram.org/bot${credential}/sendMessage`,
 credentialBotId(destination) { try { return destination ? telegramToken(destination)?.split(':')[0] : undefined } catch { return undefined } },
};
export function telegramTransport(call: TelegramCall, identity = { username: '' }): ChatTransport {
 const session = telegramSession(call);
 return {
  ...session,
  guarded(valid) { return telegramTransport((method, body, signal, authorization) => call(method, body, signal, { valid: () => valid() && (authorization?.valid?.() ?? true) }), identity); },
  async identify(signal) { const me = await session.identify(signal); identity.username = me.username;
   return me; },
  async inspect(chatId) { try { const chat = chatSchema.safeParse(await call('getChat', { chat_id: chatId }));
   return chat.success ? { id: String(chat.data.id), kind: chat.data.type === 'private' ? 'private' : 'group', eligible: ['private','group','supergroup'].includes(chat.data.type) && !chat.data.is_forum } : { id: chatId, kind: 'group', eligible: false }; } catch (error) { throw new ChatTransportError(telegramFailure(error)); } },
  connect(journal, options, now) {
   const controller = new AbortController();
   const menu = call('setMyCommands', { commands: TELEGRAM_COMMANDS }, controller.signal).catch(() => undefined);
   const poller = new TelegramPoller({ ...options, call, store: journal, now, allowedUpdates: ['message','callback_query','my_chat_member'], process: (update, epoch) => options.process(normalizeUpdate(update, identity.username), epoch) });
   return {
    start: () => poller.start(),
    health: () => poller.health(),
    async stop() {
     // Ownership may be released only after all connection work settles, including the menu.
     controller.abort();
     await Promise.all([poller.stop(), menu]);
    },
   };
  },
 };
}
