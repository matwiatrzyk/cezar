import { ChatInbound, withProvider, type ChatServiceDependencies } from '../chat/service.ts';
import { slackAdapter, type SlackAdapterDependencies } from '../chat/providers/slack/adapter.ts';
export { ChatInboundFailure } from '../chat/service.ts';
export type SlackServiceDependencies = Omit<ChatServiceDependencies, 'provider' | 'transport' | 'credentialTransport'> & SlackAdapterDependencies;
/** Slack facade over the shared service; the caller's dependencies stay live and unmodified. */
export class SlackInbound extends ChatInbound {
  constructor(deps: SlackServiceDependencies) { super(withProvider(deps, slackAdapter(deps))); }
}
