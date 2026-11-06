import { discordServiceDescriptor } from './providers/discord/index.ts';
import { slackServiceDescriptor } from './providers/slack/transport.ts';
import { telegramServiceDescriptor } from './providers/telegram/transport.ts';
import type { ChatServiceDescriptor, ChatProviderId, ChatTransport } from './provider.ts';

/** Built-ins retain their IDs and state. External factories are scoped to a canonical project root. */
export const chatProviders: readonly ChatServiceDescriptor[] = [telegramServiceDescriptor, slackServiceDescriptor, discordServiceDescriptor];
type Registration = { descriptor: ChatServiceDescriptor; transport: (credential: string, valid?: () => boolean) => ChatTransport };
const projects = new Map<string, Map<string, Registration>>();
const listeners = new Map<string, Set<(id: ChatProviderId) => Promise<void>>>();
async function changed(scope: string, id: ChatProviderId) { await Promise.all([...listeners.get(scope) ?? []].map(listener => listener(id))); }
export async function registerChatExtension(scope: string, descriptor: ChatServiceDescriptor, transport: Registration['transport']): Promise<() => Promise<void>> {
  if (!scope || !descriptor.id.includes('/') || descriptor.format !== `${descriptor.id}.v1`) throw Error('Extension chat providers require a project and extensionId/localId identifier');
  const providers = projects.get(scope) ?? new Map<string, Registration>();
  if (providers.has(descriptor.id)) throw Error(`Chat provider already registered: ${descriptor.id}`);
  projects.set(scope, providers);
  const registration = { descriptor, transport };
  providers.set(descriptor.id, registration);
  const dispose = async () => {
    if (providers.get(descriptor.id) !== registration) return;
    providers.delete(descriptor.id);
    if (!providers.size) projects.delete(scope);
    await changed(scope, descriptor.id);
  };
  try { await changed(scope, descriptor.id); } catch (error) { await dispose(); throw error; }
  return dispose;
}
export function watchChatExtensions(scope: string, listener: (id: ChatProviderId) => Promise<void>): () => void {
  const set = listeners.get(scope) ?? new Set(); listeners.set(scope, set); set.add(listener);
  return () => { set.delete(listener); if (!set.size) listeners.delete(scope); };
}
export function projectChatExtensions(scope: string): ChatServiceDescriptor[] { return [...projects.get(scope)?.values() ?? []].map(item => item.descriptor); }
export const chatProvider = (id: ChatProviderId, scope?: string): ChatServiceDescriptor | undefined => chatProviders.find(provider => provider.id === id) ?? (scope ? projects.get(scope)?.get(id)?.descriptor : undefined);
export const chatTransport = (scope: string, id: ChatProviderId, credential: string, valid?: () => boolean): ChatTransport | undefined => projects.get(scope)?.get(id)?.transport(credential, valid);
