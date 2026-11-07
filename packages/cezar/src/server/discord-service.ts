import { ChatInbound, withProvider, type ChatServiceDependencies } from '../chat/service.ts';
import { discordAdapter, type DiscordAdapterDependencies } from '../chat/providers/discord/adapter.ts';
export { ChatInboundFailure } from '../chat/service.ts';
export type DiscordServiceDependencies = Omit<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'> & DiscordAdapterDependencies;
/** Discord facade over the shared service; the caller's dependencies stay live and unmodified. */
export class DiscordInbound extends ChatInbound {
  constructor(deps: DiscordServiceDependencies) { super(withProvider(deps, discordAdapter(deps))); }
}
