import { z } from 'zod'
import { slackAppTokenPattern, slackBotTokenPattern } from '@open-mercato/cezar-contract'
import { ChatTransportError, type ChatTransport } from '../../provider.ts'
import type { BundledWorkerHost } from '../../../extensions/bundled-worker.ts'
import { decodeSlackCredentials } from './identity.ts'
import { ChatSecretError } from '../../credentials.ts'
import { createSlackWire } from './client.ts'
import { slackTransport } from './transport.ts'

/** What the Slack worker may hold: access tokens only. Refresh tokens and the client secret stay
 *  in the host, which rotates through the explicit `rotate` request (spec 2026-11-07, #F5). */
export function slackWorkerConfig(credential: string): Record<string, string> {
  const { appToken, botToken } = decodeSlackCredentials(credential)
  return { appToken, botToken }
}

// Access tokens only: the full record would demand the refresh token and secret for an xoxe. token.
const workerCredentials = z.strictObject({ appToken: z.string().regex(slackAppTokenPattern), botToken: z.string().regex(slackBotTokenPattern) })
const decodeWorker = (value: string) => { try { return workerCredentials.parse(JSON.parse(value)) } catch { throw new ChatSecretError() } }
const rotated = { app: z.object({ token: z.string().regex(slackAppTokenPattern) }).strict(), bot: z.object({ token: z.string().regex(slackBotTokenPattern) }).strict() }

/** Worker side: the same transport and Socket Mode connection the compatibility path runs. */
export function slackWorkerTransport(config: Record<string, string>, host: BundledWorkerHost, options: { fetch?: typeof fetch } = {}): ChatTransport {
  const credentials = decodeWorker(JSON.stringify(config))
  const rotation = {
    async token(_: unknown, kind: 'app' | 'bot', signal?: AbortSignal, valid: () => boolean = () => true) {
      const initial = credentials[`${kind}Token`]
      if (!initial.startsWith('xoxe.')) return initial
      if (signal?.aborted || !valid()) throw new ChatTransportError({ kind: 'blocked' })
      const answer = rotated[kind].safeParse(await host.request('rotate', { kind }, 30_000))
      // A malformed answer is a host fault; SlackTokenRotation maps the same case to transient.
      if (!answer.success) throw new ChatTransportError({ kind: 'transient' })
      const { token } = answer.data
      if (signal?.aborted || !valid()) throw new ChatTransportError({ kind: 'blocked' })
      return token
    },
  }
  return slackTransport(createSlackWire(async () => JSON.stringify(credentials), { rotation, decode: decodeWorker, ...(options.fetch ? { fetch: options.fetch } : {}) }))
}

export const slackRotateInputSchema = z.object({ kind: z.enum(['app', 'bot']) }).strict()
