import { discordServiceDescriptor } from './providers/discord/index.ts'
import { slackServiceDescriptor } from './providers/slack/transport.ts'
import { telegramServiceDescriptor } from './providers/telegram/transport.ts'
import type { ChatServiceDescriptor } from './provider.ts'

/**
 * Providers shipped inside the cezar artifact. Keep this catalog separate from the external
 * worker registry: these adapters own compatibility-sensitive transports (Slack token rotation
 * and Discord Gateway/native commands) and therefore must not be silently re-keyed as
 * `extensionId/localId` providers. The catalog is the seam for a future bundled-worker pilot.
 */
export const bundledChatProviders: readonly ChatServiceDescriptor[] = [
  telegramServiceDescriptor,
  slackServiceDescriptor,
  discordServiceDescriptor,
]

export function bundledChatProvider(id: string): ChatServiceDescriptor | undefined {
  return bundledChatProviders.find(provider => provider.id === id)
}
