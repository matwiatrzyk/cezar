import { z } from 'zod'
import type { ChatTransport } from '../../provider.ts'
import { decodeDiscordCredentials } from './identity.ts'
import { discordTransport } from './index.ts'

/** The Discord worker needs the bot token itself: the Gateway IDENTIFY frame carries it. */
export const discordWorkerConfigSchema = z.object({ token: z.string().min(1).max(32768) }).strict()

/** Worker side: the same REST session and Gateway (holds, ACKs, native commands) as compatibility. */
export function discordWorkerTransport(config: Record<string, string>): ChatTransport {
  const { token } = discordWorkerConfigSchema.parse(config)
  decodeDiscordCredentials(token)
  return discordTransport({ token })
}
