import { z } from 'zod'
import type { BundledWorkerHost } from '../../../extensions/bundled-worker.ts'
import { telegramClient } from './client.ts'
import { telegramTransport } from './transport.ts'

const configSchema = z.object({ token: z.string().min(1).max(32768) }).strict()
export function telegramWorkerConfig(token: string): Record<string, string> { return configSchema.parse({ token }) }

/** Worker side: Telegram's polling transport with the token supplied for one bot by the host. */
export function telegramWorkerTransport(config: Record<string, string>, _host: BundledWorkerHost) {
  const { token } = configSchema.parse(config)
  return telegramTransport(telegramClient({ token: async () => token, policy: { mode: 'local', allowLocalNetwork: false, serverPorts: [] } }))
}
