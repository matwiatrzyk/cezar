import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { Trends } from './trends'
import type { DashboardCosts, DashboardCostSeriesPoint } from '@open-mercato/cezar-api-client'
const at = '2026-09-19T00:00:00.000Z'
function point(
  date: string,
  extra: Partial<DashboardCostSeriesPoint> = {},
): DashboardCostSeriesPoint {
  return {
    date,
    tasks: 0,
    completed: 0,
    avgCycleHours: null,
    medianCycleHours: null,
    ...extra,
  }
}
function fixture(period: DashboardCosts['period'] = '7d'): DashboardCosts {
  const series =
    period === 'all'
      ? []
      : Array.from({ length: period === '7d' ? 7 : 30 }, (_, i) =>
          point(`2026-09-${String(13 + i).padStart(2, '0')}`),
        )
  if (series.length) {
    series[series.length - 1] = point(series.at(-1)!.date, {
      tasks: 2,
      completed: 1,
      avgCycleHours: 2,
      medianCycleHours: 2,
      costUsd: { value: 3, reportedTasks: 2 },
      inputTokens: { value: 10, reportedTasks: 1 },
      outputTokens: { value: 20, reportedTasks: 1 },
    })
  }
  return {
    snapshotId: 's1',
    asOf: at,
    expiresAt: '2026-09-19T00:01:00.000Z',
    scope: 'retained-task-lifetime',
    period,
    windowStart: period === 'all' ? null : at,
    sort: 'cost',
    visibility: { tokens: true, cost: true },
    coverage: { projects: [{ projectId: 'shop', state: 'complete', omittedRuns: 0 }] },
    invalidDateTasks: 0,
    totals: { tasks: 2, costUsd: { value: 3, reportedTasks: 2 } },
    series,
    projects: [],
    tasks: { rows: [], total: 0, nextOffset: null },
  }
}
function setup(visibility = { tokens: true, cost: true }) {
  const calls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost')
      calls.push(url)
      const period = (url.searchParams.get('period') as DashboardCosts['period']) ?? '7d'
      return new Response(JSON.stringify(fixture(period)))
    }),
  )
  const client = createQueryClient()
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Trends visibility={visibility} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { calls, ...view }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('renders per-metric trend charts and the throughput summary', async () => {
  setup()
  expect((await screen.findAllByText('Reported USD')).length).toBeGreaterThan(0)
  expect(screen.getAllByText('Input tokens').length).toBeGreaterThan(0)
  expect(screen.getAllByText('Output tokens').length).toBeGreaterThan(0)
  expect(screen.getByText('Completed tasks')).toBeTruthy()
  expect(screen.getByText(/1 done · avg cycle 2\.0h/)).toBeTruthy()
})
it('hides gated metrics but still shows throughput', async () => {
  setup({ tokens: false, cost: false })
  expect(await screen.findByText('Completed tasks')).toBeTruthy()
  expect(screen.queryByText('Reported USD')).toBeNull()
  expect(screen.queryByText('Input tokens')).toBeNull()
})
it('renders daily values for the screen disclosure and PDF report', async () => {
  setup()
  await screen.findByText('Completed tasks')
  const table = document.querySelector('table')
  expect(table).toBeTruthy()
  expect(table?.className).not.toContain('hidden')
  expect(table?.textContent).toContain('$3.00')
  expect(table?.textContent).toContain('10')
  expect(table?.textContent).toContain('20')
})
it('requests only 7d/30d and refetches on period change', async () => {
  const { calls } = setup()
  await screen.findByText('Completed tasks')
  expect(calls.every((u) => u.searchParams.get('period') !== 'all')).toBe(true)
  fireEvent.change(screen.getByLabelText('Period'), { target: { value: '30d' } })
  await waitFor(() =>
    expect(calls.some((u) => u.searchParams.get('period') === '30d')).toBe(true),
  )
})

it('keeps unknown daily amounts distinct from zero and names chart controls', async () => {
  setup()
  await screen.findByText('Completed tasks')
  expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0)
  const bars = document.querySelectorAll('button[data-export-keep]')
  expect(bars.length).toBeGreaterThan(0)
  for (const bar of bars) expect(bar.getAttribute('aria-label')).toBeTruthy()
  expect(document.querySelector('.print\\:hidden')).toBeNull()
})
