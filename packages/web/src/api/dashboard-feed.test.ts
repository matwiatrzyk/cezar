import { createElement } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { useDashboardFeed } from './dashboard'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it.each(['github', 'all'] as const)(
  'retries the failed GitHub request in %s feed',
  async (filter) => {
    const requests: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        requests.push(String(input))
        return new Response(JSON.stringify({ error: 'offline' }), { status: 503 })
      }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const hook = renderHook(() => useDashboardFeed(filter, true), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    })
    await waitFor(() => expect(hook.result.current.githubError).toBe(true))
    const before = requests.filter((url) => url.includes('filter=github')).length
    await act(async () => {
      await hook.result.current.retryFailed()
    })
    expect(requests.filter((url) => url.includes('filter=github')).length).toBe(before + 1)
    if (filter === 'github')
      expect(requests.some((url) => url.includes('filter=tasks'))).toBe(false)
    hook.unmount()
    client.clear()
  },
)
