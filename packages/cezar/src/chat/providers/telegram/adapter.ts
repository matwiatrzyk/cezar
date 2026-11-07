import type { ChatProviderAdapter } from '../../service.ts';
import type { TelegramCall } from './client.ts';
import { telegramServiceDescriptor, telegramTransport } from './transport.ts';

export interface TelegramAdapterDependencies { call(receiverId: string): TelegramCall; callToken?(credential: string): TelegramCall }
/** Providers get only a transport, never the project dependency object; calls stay live. */
export function telegramAdapter(deps: TelegramAdapterDependencies): ChatProviderAdapter {
  return {
    provider: telegramServiceDescriptor,
    transport: id => telegramTransport(deps.call(id)),
    get credentialTransport() { return deps.callToken ? (credential: string) => telegramTransport(deps.callToken!(credential)) : undefined; },
  };
}
