import { createElement } from 'react'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { DashboardCosts } from '@open-mercato/cezar-api-client'
import { useCostTasks } from './dashboard-costs'
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
it.each([-120, -840, 600])(
  'preserves original offset %s when recovering an expired cost cohort',
  async (offset) => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(0)
    const snapshot = {
      snapshotId: 'old',
      asOf: '2026-09-20T06:00:00Z',
      expiresAt: '2026-09-20T06:01:00Z',
      scope: 'retained-task-lifetime',
      period: '7d',
      windowStart: '2026-09-13T22:00:00Z',
      sort: 'cost',
      visibility: { cost: true, tokens: true },
      coverage: { projects: [] },
      invalidDateTasks: 0,
      totals: { tasks: 0 },
      series: [],
      projects: [],
      tasks: { rows: [], total: 0, nextOffset: null },
      tzOffsetMinutes: offset,
    } as DashboardCosts
    const requests: URL[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input) => {
        const url = new URL(String(input), 'http://localhost')
        requests.push(url)
        return url.searchParams.has('snapshotId')
          ? new Response(JSON.stringify({ error: 'expired' }), { status: 409 })
          : new Response(JSON.stringify({ ...snapshot, snapshotId: 'fresh' }))
      }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const hook = renderHook(() => useCostTasks(snapshot, undefined, 'cost', 20), {
      wrapper: ({ children }) => createElement(QueryClientProvider, { client }, children),
    })
    await waitFor(() => expect(hook.result.current.isSuccess).toBe(true))
    expect(requests).toHaveLength(2)
    expect(requests[1]!.searchParams.get('tzOffsetMinutes')).toBe(String(offset))
    hook.unmount()
    client.clear()
  },
)
