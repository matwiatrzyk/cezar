import { describe, expect, it } from 'vitest'
import { discordWorkerConfigSchema, discordWorkerTransport } from './bundled-adapter.ts'
import { encodeDiscordCredentials } from './index.ts'

describe('bundled Discord worker adapter', () => {
  it('accepts exactly the encoded bot token', () => {
    const token = encodeDiscordCredentials({ token: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GaBcDe.abcdefghijklmnopqrstuvwxyz012345' })
    expect(Object.keys(discordWorkerTransport({ token }))).toEqual(expect.arrayContaining(['identify', 'send', 'connect', 'guarded']))
    expect(() => discordWorkerConfigSchema.parse({ token, extra: 'x' })).toThrow()
    expect(() => discordWorkerTransport({ token: 'not-a-token' })).toThrow()
  })
})
