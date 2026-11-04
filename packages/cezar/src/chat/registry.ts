import { discordServiceDescriptor } from './providers/discord/index.ts';
import { slackServiceDescriptor } from './providers/slack/transport.ts';
import type { ChatServiceDescriptor, ChatProviderId } from './provider.ts';
import { telegramServiceDescriptor } from './providers/telegram/transport.ts';
/** In-tree registration only. Importing the registry never opens a connection. */
export const chatProviders: readonly ChatServiceDescriptor[] = [telegramServiceDescriptor, slackServiceDescriptor, discordServiceDescriptor];
export const chatProvider = (id: ChatProviderId): ChatServiceDescriptor | undefined => chatProviders.find(provider => provider.id === id);
