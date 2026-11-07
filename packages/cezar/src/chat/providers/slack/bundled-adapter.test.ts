import { describe, expect, it, vi } from 'vitest'
vi.mock('./transport.ts', () => ({ slackTransport: () => ({ identify: async () => ({ id: 'T1:U1', username: 'T1:U1' }), inspect: async (id: string) => ({ id, kind: id.startsWith('private:') ? 'private' : 'group', eligible: true }), send: async (id: string) => ({ chatId: id, messageId: '1700000000.000001' }), clearButtons: async () => {}, isMember: async () => true }) }))
vi.mock('./client.ts', () => ({ createSlackWire: () => ({ call: async () => ({ team_id: 'T1', user_id: 'U1', url: 'wss://wss-primary.slack.com/' }), socket: () => { throw Error('not used') } }), slackError: (code: string) => Error(code) }))
vi.mock('./normalize.ts', () => ({ normalizeSlackEnvelope: async () => undefined, slackEnvelope: { safeParse: () => ({ success: false }) } }))
vi.mock('./identity.ts', () => ({ decodeSlackCredentials: (value: string) => JSON.parse(value) }))
import { acceptSlackBundledFrame, createSlackAdapter } from './bundled-adapter.ts'

describe('bundled Slack adapter', () => {
 it('creates the SDK surface without doing platform I/O', () => {
  const adapter = createSlackAdapter({ appToken: 'xapp-test-app-token-long', botToken: 'xoxb-test-bot-token-long' })
  expect(Object.keys(adapter)).toEqual(['identify', 'inspect', 'send', 'clearButtons', 'acknowledge', 'isMember', 'receive', 'dispose'])
 })

 it('accepts the same persisted credential record passed by the host', () => {
 expect(createSlackAdapter({ appToken: 'xapp-test-app-token-long', botToken: 'xoxb-test-bot-token-long' })).toBeDefined()
 })

 it('accepts before checkpointing and fences stale generations', async () => {
  const accept = vi.fn(async () => undefined), checkpoint = vi.fn(async () => undefined)
  const frame = { type: 'event' as const, providerId: 'slack', generation: 'g1', cursor: 4, event: { kind: 'message', id: 'message:1' } }
  await expect(acceptSlackBundledFrame(frame, 'stale', accept, checkpoint)).resolves.toBe(false)
  await expect(acceptSlackBundledFrame(frame, 'g1', accept, checkpoint)).resolves.toBe(true)
  expect(accept).toHaveBeenCalledBefore(checkpoint)
  expect(checkpoint).toHaveBeenCalledWith(4)
 })
})
