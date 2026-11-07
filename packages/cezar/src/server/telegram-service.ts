import { ChatInbound, withProvider, type ChatServiceDependencies } from '../chat/service.ts';
import { telegramAdapter, type TelegramAdapterDependencies } from '../chat/providers/telegram/adapter.ts';
export { ChatInboundFailure } from '../chat/service.ts';
export type TelegramServiceDependencies = Omit<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'> & TelegramAdapterDependencies;
/** Telegram facade over the shared service; the caller's dependencies stay live and unmodified. */
export class TelegramInbound extends ChatInbound {
  constructor(deps: TelegramServiceDependencies) { super(withProvider(deps, telegramAdapter(deps))); }
}
