import type { ChatServiceDescriptor, ChatProviderId } from './provider.ts';
import { telegramServiceDescriptor } from './providers/telegram/transport.ts';
/** In-tree registration only. Importing the registry never opens a connection. */
export const chatProviders: readonly ChatServiceDescriptor[] = [telegramServiceDescriptor];
export const chatProvider = (id: ChatProviderId): ChatServiceDescriptor | undefined => chatProviders.find(provider => provider.id === id);
