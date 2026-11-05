import { discordServiceDescriptor } from './providers/discord/index.ts';
import { slackServiceDescriptor } from './providers/slack/transport.ts';
import type { ChatServiceDescriptor, ChatProviderId } from './provider.ts';
import { telegramServiceDescriptor } from './providers/telegram/transport.ts';
import type { ChatTransport } from './provider.ts';
/** In-tree registration only. Importing the registry never opens a connection. */
const extensionProviders = new Map<string, { descriptor: ChatServiceDescriptor; transport: (valid?: () => boolean) => ChatTransport }>();
export const chatProviders: readonly ChatServiceDescriptor[] = [telegramServiceDescriptor, slackServiceDescriptor, discordServiceDescriptor];
export function registerChatExtension(descriptor: ChatServiceDescriptor, transport: (valid?: () => boolean) => ChatTransport): () => void {
  if (!descriptor.id.includes('/') || descriptor.format !== `${descriptor.id}.v1`) throw new Error('Extension chat providers use an extensionId/localId identifier');
  if (extensionProviders.has(descriptor.id)) throw new Error(`Chat provider already registered: ${descriptor.id}`);
  extensionProviders.set(descriptor.id, { descriptor, transport });
  return () => { if (extensionProviders.get(descriptor.id)?.descriptor === descriptor) extensionProviders.delete(descriptor.id); };
}
export const chatProvider = (id: ChatProviderId): ChatServiceDescriptor | undefined => chatProviders.find(provider => provider.id === id) ?? extensionProviders.get(id)?.descriptor;
export const chatTransport = (id: ChatProviderId, valid?: () => boolean): ChatTransport | undefined => extensionProviders.get(id)?.transport(valid);
