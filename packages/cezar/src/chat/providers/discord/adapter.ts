import type { ChatProviderAdapter } from '../../service.ts';
import { discordServiceDescriptor, discordTransport, type DiscordTransportOptions } from './index.ts';

export interface DiscordAdapterDependencies { dryRun?: boolean; discord(receiverId: string): DiscordTransportOptions; discordCredential?(credential: string): DiscordTransportOptions }
/** Credential access stays with the host; the transport never receives a vault or project. */
export function discordAdapter(deps: DiscordAdapterDependencies): ChatProviderAdapter {
  return {
    provider: discordServiceDescriptor,
    transport: id => discordTransport({ dryRun: deps.dryRun, ...deps.discord(id) }),
    credentialTransport: credential => discordTransport({ dryRun: deps.dryRun, ...(deps.discordCredential?.(credential) ?? { token: credential }) }),
  };
}
