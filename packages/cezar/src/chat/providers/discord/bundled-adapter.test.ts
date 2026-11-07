import { describe, expect, it, vi } from 'vitest'
import { acceptDiscordBundledFrame, discordBundledContextSchema, encodeDiscordBundledOperation } from './bundled-adapter.ts'

describe('Discord bundled worker boundary', () => {
  it('validates bounded gateway, ACK and native-command operations', () => {
    expect(encodeDiscordBundledOperation({ type: 'gatewayConnect', cursor: 4 })).toEqual({ type: 'gatewayConnect', cursor: 4 })
    expect(encodeDiscordBundledOperation({ type: 'interactionAck', eventId: 'interaction:1', payload: { type: 6 } })).toMatchObject({ eventId: 'interaction:1' })
    expect(encodeDiscordBundledOperation({ type: 'nativeCommand', eventId: 'interaction:2', payload: { query: 'tas', chatId: 'discord:dm:1', userId: '2' } })).toMatchObject({ type: 'nativeCommand' })
    expect(() => encodeDiscordBundledOperation({ type: 'gatewayConnect', payload: () => {} })).toThrow()
    expect(() => encodeDiscordBundledOperation({ type: 'nativeCommand', eventId: 'interaction:3', payload: { query: 'tas' } })).toThrow()
    expect(() => discordBundledContextSchema.parse({ projectId: 'p', token: '' })).toThrow()
  })

  it('accepts only the current Discord generation and checkpoints after durable acceptance', async () => {
    const accept = vi.fn(async () => undefined), checkpoint = vi.fn(async () => undefined)
    const frame = { type: 'event' as const, providerId: 'discord', generation: 'g1', cursor: 9, event: { kind: 'message', id: 'message:1' } }
    await expect(acceptDiscordBundledFrame(frame, 'stale', accept, checkpoint)).resolves.toBe(false)
    expect(accept).not.toHaveBeenCalled()
    await expect(acceptDiscordBundledFrame(frame, 'g1', accept, checkpoint)).resolves.toBe(true)
    expect(accept).toHaveBeenCalledBefore(checkpoint)
    expect(checkpoint).toHaveBeenCalledWith(9)
  })

  it('does not checkpoint when durable acceptance fails', async () => {
    const accept = vi.fn(async () => { throw new Error('journal unavailable') }), checkpoint = vi.fn(async () => undefined)
    await expect(acceptDiscordBundledFrame({ type: 'event', providerId: 'discord', generation: 'g1', cursor: 2, event: {} }, 'g1', accept, checkpoint)).rejects.toThrow('journal unavailable')
    expect(checkpoint).not.toHaveBeenCalled()
  })
})
