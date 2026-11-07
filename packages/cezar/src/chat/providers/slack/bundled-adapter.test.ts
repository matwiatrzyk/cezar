import { describe, expect, it } from 'vitest'
import { slackWorkerConfig, slackWorkerTransport } from './bundled-adapter.ts'

const rotating = JSON.stringify({ appToken: 'xoxe.xapp-1-initial-app-token', botToken: 'xoxe.xoxb-1-initial-bot-token', appRefreshToken: 'xoxe-1-refresh-app-token', botRefreshToken: 'xoxe-1-refresh-bot-token', clientId: '123.456', clientSecret: 'abcdefghijklmnop1234' })

describe('bundled Slack worker adapter', () => {
  it('hands the worker access tokens only, never the refresh tokens or client secret (#F5)', () => {
    expect(slackWorkerConfig(rotating)).toEqual({ appToken: 'xoxe.xapp-1-initial-app-token', botToken: 'xoxe.xoxb-1-initial-bot-token' })
  })

  it('rotates an xoxe. token through the bounded host request and sends the rotated token (#F5)', async () => {
    const asked: unknown[] = [], auth: string[] = []
    const host = { request: async (method: string, params?: { kind: string }) => { asked.push([method, params]); return { token: params?.kind === 'app' ? 'xoxe.xapp-1-rotated-app-token' : 'xoxe.xoxb-1-rotated-bot-token' } } }
    const fetch = (async (_url: string, init: RequestInit) => { auth.push((init.headers as Record<string, string>).Authorization!); return new Response(JSON.stringify({ ok: true, team_id: 'T1', user_id: 'U1' })) }) as typeof globalThis.fetch
    const transport = slackWorkerTransport(slackWorkerConfig(rotating), host as never, { fetch })
    await expect(transport.identify()).resolves.toEqual({ id: 'T1:U1', username: 'T1:U1' })
    expect(asked).toContainEqual(['rotate', { kind: 'bot' }])
    expect(auth).toEqual(['Bearer xoxe.xoxb-1-rotated-bot-token'])
  })

  it('maps a malformed rotation answer to a retryable failure', async () => {
    const transport = slackWorkerTransport(slackWorkerConfig(rotating), { request: async () => ({ token: 'nope' }) } as never)
    await expect(transport.identify()).rejects.toMatchObject({ failure: { kind: 'transient' } })
  })

  it('does not ask the host for a non-rotating token', async () => {
    const asked: unknown[] = []
    const fetch = (async () => new Response(JSON.stringify({ ok: true, team_id: 'T1', user_id: 'U1' }))) as unknown as typeof globalThis.fetch
    const transport = slackWorkerTransport({ appToken: 'xapp-1-plain-app-token', botToken: 'xoxb-1-plain-bot-token' }, { request: async (...args: unknown[]) => { asked.push(args) } } as never, { fetch })
    await transport.identify()
    expect(asked).toEqual([])
  })

  it('rejects anything but the two access tokens', () => {
    expect(() => slackWorkerTransport({ appToken: 'xapp-1-plain-app-token', botToken: 'xoxb-1-plain-bot-token', clientSecret: 'abcdefghijklmnop1234' }, { request: async () => undefined } as never)).toThrow()
  })
})
