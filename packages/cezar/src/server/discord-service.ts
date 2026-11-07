import { ChatInbound, type ChatServiceDependencies } from '../chat/service.ts';
import { discordServiceDescriptor, discordTransport, type DiscordTransportOptions } from '../chat/providers/discord/index.ts';
export { acceptDiscordBundledFrame, discordBundledContextSchema, discordBundledOperationSchema, discordBundledTransport, encodeDiscordBundledOperation, type DiscordBundledContext, type DiscordBundledOperation } from '../chat/providers/discord/bundled-adapter.ts';
export { ChatInboundFailure } from '../chat/service.ts';
export type DiscordServiceDependencies = Omit<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'> & {
 discord(receiverId: string): DiscordTransportOptions;
 discordCredential?(credential: string): DiscordTransportOptions;
};
/** Credential access stays with the host; the transport never receives a vault or project. */
export class DiscordInbound extends ChatInbound {
 constructor(deps: DiscordServiceDependencies) {
  const adapted = Object.defineProperties(deps, {
   provider: { configurable: true, value: discordServiceDescriptor },
   transport: { configurable: true, value: (id: string) => discordTransport({ dryRun: deps.dryRun, ...deps.discord(id) }) },
   credentialTransport: { configurable: true, get: () => (credential: string) => discordTransport({ dryRun: deps.dryRun, ...(deps.discordCredential?.(credential) ?? { token: credential }) }) },
  }) as DiscordServiceDependencies & ChatServiceDependencies;
  super(adapted);
 }
}
