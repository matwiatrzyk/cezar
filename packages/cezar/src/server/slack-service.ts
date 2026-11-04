import { ChatInbound, type ChatServiceDependencies } from '../chat/service.ts';
import { slackServiceDescriptor, slackTransport } from '../chat/providers/slack/transport.ts';
import type { SlackWire } from '../chat/providers/slack/client.ts';
export { ChatInboundFailure } from '../chat/service.ts';
export type SlackServiceDependencies = Omit<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'> & {
 wire(receiverId: string): SlackWire; wireCredential?(credential: string): SlackWire;
};
/** The facade alone sees project dependencies; wire clients receive only resolved credentials. */
export class SlackInbound extends ChatInbound {
 constructor(deps: SlackServiceDependencies) {
  const adapted = Object.defineProperties(deps, {
   provider: { configurable: true, value: slackServiceDescriptor },
   transport: { configurable: true, value: (id: string) => slackTransport(deps.wire(id)) },
   credentialTransport: { configurable: true, get: () => deps.wireCredential ? (credential: string) => slackTransport(deps.wireCredential!(credential)) : undefined },
  }) as SlackServiceDependencies & ChatServiceDependencies;
  super(adapted);
 }
}
