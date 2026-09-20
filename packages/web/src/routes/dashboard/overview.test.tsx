import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router'
import { createQueryClient } from '@/api/query-client'
import { Overview } from './overview'
import type { DashboardOverview } from '@open-mercato/cezar-api-client'
const at = '2026-09-19T12:00:00.000Z'
const metrics = {
  running: 1,
  needsYou: 2,
  completed: 5,
  failed: 1,
  timedTasks: 4,
  medianCycleHours: 3,
}
const fixture: DashboardOverview = {
  snapshotId: 's',
  asOf: at,
  windowStart: '2026-09-13T00:00:00.000Z',
  period: '7d',
  coverage: { projects: [{ projectId: 'alpha', state: 'complete', omittedRuns: 0 }] },
  metrics,
  projects: [{ projectId: 'alpha', ...metrics }],
  page: { total: 5, nextOffset: null, rows: [] },
}
function Location() {
  return <output data-testid="overview-location">{useLocation().search}</output>
}
function setup(active = true) {
  const calls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost')
      calls.push(url)
      if (url.pathname.endsWith('/projects'))
        return new Response(JSON.stringify({ projects: [], bootProject: 'alpha' }))
      return new Response(JSON.stringify(fixture))
    }),
  )
  const client = createQueryClient()
  const view = (isActive: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Location />
        <Overview active={isActive}>
          {(modules) => (
            <>
              {modules.overview}
              <p>Attention queue</p>
              {modules.portfolio}
            </>
          )}
        </Overview>
      </MemoryRouter>
    </QueryClientProvider>
  )
  const result = render(view(active))
  return { calls, rerender: (isActive: boolean) => result.rerender(view(isActive)) }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('shows outcome scope and opens the exact project/group snapshot', async () => {
  const { calls } = setup()
  await screen.findByRole('button', { name: 'Completed: 5' })
  expect(screen.getByText(/Median cycle time/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'alpha: Failed outcomes' }))
  await screen.findByRole('dialog')
  await waitFor(() =>
    expect(
      calls.some(
        (url) =>
          url.searchParams.get('snapshotId') === 's' &&
          url.searchParams.get('projectId') === 'alpha' &&
          url.searchParams.get('group') === 'failed',
      ),
    ).toBe(true),
  )
})
it('does not query overview while another view is active', () => {
  const { calls } = setup(false)
  expect(screen.getByText('Attention queue')).toBeTruthy()
  expect(screen.queryByText('Workspace overview')).toBeNull()
  expect(calls.filter((url) => url.pathname.includes('/dashboard/overview'))).toHaveLength(0)
})
it('closes the outcome Sheet when the view goes inactive, so it never reopens on return', async () => {
  const { rerender } = setup()
  await screen.findByRole('button', { name: 'Completed: 5' })
  fireEvent.click(screen.getByRole('button', { name: 'alpha: Failed outcomes' }))
  await screen.findByRole('dialog')
  rerender(false)
  rerender(true)
  await screen.findByRole('button', { name: 'Completed: 5' })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('writes the reporting period into the URL', async () => {
  setup()
  await screen.findByRole('button', { name: 'Completed: 5' })
  fireEvent.change(screen.getByLabelText('Outcomes period'), { target: { value: '30d' } })
  expect(screen.getByTestId('overview-location').textContent).toBe('?period=30d')
})
