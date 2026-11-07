import type { ChatProviderAdapter } from '../../service.ts';
import type { SlackWire } from './client.ts';
import { slackServiceDescriptor, slackTransport } from './transport.ts';

export interface SlackAdapterDependencies { wire(receiverId: string): SlackWire; wireCredential?(credential: string): SlackWire }
/** Wire clients receive only resolved credentials; the factories stay live. */
export function slackAdapter(deps: SlackAdapterDependencies): ChatProviderAdapter {
  return {
    provider: slackServiceDescriptor,
    transport: id => slackTransport(deps.wire(id)),
    get credentialTransport() { return deps.wireCredential ? (credential: string) => slackTransport(deps.wireCredential!(credential)) : undefined; },
  };
}
