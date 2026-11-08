import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useExtensionSubscription } from './extensions'
import { queryKeys } from './queries'
import { subscribeTopic } from './ws'

vi.mock('./ws', () => ({ subscribeTopic: vi.fn(() => () => {}) }))
afterEach(() => { cleanup(); vi.mocked(subscribeTopic).mockClear() })

/** Review 430da81e F1: the extensions topic is local-only, like every other WebSocket topic — a
 *  hosted cockpit (extensions capability off) must not open a browser socket from any page. */
function mount(extensions: boolean | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } })
  client.setQueryData(queryKeys.health, { capabilities: { localHandoff: extensions === true, extensions } } as never)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  return renderHook(() => useExtensionSubscription('alpha'), { wrapper })
}

describe('useExtensionSubscription', () => {
  it('subscribes only when the cockpit reports extensions as available', () => {
    mount(true)
    expect(subscribeTopic).toHaveBeenCalledWith('extensions', expect.any(Function))
  })
  it('opens no topic on a hosted cockpit or before health answered', () => {
    mount(false)
    mount(undefined)
    expect(subscribeTopic).not.toHaveBeenCalled()
  })
})
