import { describe, expect, it, vi } from 'vitest'
import { bundledChatFrameSchema } from './protocol.ts'
import { registerBundledChatProvider } from '../chat/registry.ts'

describe('bundled worker boundary', () => {
  it('accepts event and health frames but rejects cross-provider frames', () => {
    expect(bundledChatFrameSchema.parse({ type: 'event', providerId: 'slack', generation: 'g', cursor: 4, event: { id: 'e' } })).toMatchObject({ cursor: 4 })
    expect(bundledChatFrameSchema.parse({ type: 'health', providerId: 'discord', generation: 'g', state: 'polling' })).toMatchObject({ state: 'polling' })
    expect(() => bundledChatFrameSchema.parse({ type: 'event', providerId: 'slack', generation: 'g', cursor: -1 })).toThrow()
  })

  it('registers a stable bundled alias once per project and disposes it', async () => {
    const descriptor = { id: 'slack' as const, label: 'Slack', format: 'slack.v1', credentials: [], ids: {}, presentation: {}, limits: {} } as never
    const transport = (() => ({})) as never
    const dispose = await registerBundledChatProvider('bundled-test', descriptor, transport)
    await expect(registerBundledChatProvider('bundled-test', descriptor, transport)).rejects.toThrow('already registered')
    expect((await import('../chat/registry.ts')).chatProvider('slack', 'bundled-test')).toBe(descriptor)
    await dispose()
    expect((await import('../chat/registry.ts')).chatProvider('slack', 'bundled-test')).not.toBe(descriptor)
  })

  it('does not invoke a stale frame handler', async () => {
    const onEvent = vi.fn()
    const { acceptBundledFrame } = await import('./bundled-runtime.ts')
    acceptBundledFrame({ type: 'event', providerId: 'slack', generation: 'old', event: { id: 'e' } }, 'new', onEvent)
    expect(onEvent).not.toHaveBeenCalled()
  })
})
