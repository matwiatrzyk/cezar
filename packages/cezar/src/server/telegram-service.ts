import { chatProvider } from '../chat/registry.ts';
import { ChatInbound, type ChatServiceDependencies } from '../chat/service.ts';
import { telegramTransport } from '../chat/providers/telegram/transport.ts';
import type { TelegramCall } from '../chat/providers/telegram/client.ts';
export { ChatInboundFailure } from '../chat/service.ts';
type Dependencies = Omit<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'> & {
 call(receiverId: string): TelegramCall; callToken?(credential: string): TelegramCall;
};
/** Composition boundary: providers get only a transport, never this project dependency object. */
export class TelegramInbound extends ChatInbound {
 constructor(deps: Dependencies) {
  // Keep live dependency properties live (configuration and test transports may rotate in place).
  const adapted = Object.defineProperties(deps, {
   provider: { configurable: true, value: chatProvider('telegram')! },
   transport: { configurable: true, value: (id: string) => telegramTransport(deps.call(id)) },
   credentialTransport: { configurable: true, get: () => deps.callToken ? (credential: string) => telegramTransport(deps.callToken!(credential)) : undefined },
  }) as Dependencies & ChatServiceDependencies;
  super(adapted);
 }
}
