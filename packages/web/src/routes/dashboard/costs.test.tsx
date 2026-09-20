import { QueryClientProvider } from '@tanstack/react-query'
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
  act,
} from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { workspaceQueryKeys } from '@/api/queries'
import { UsageCosts } from './costs'
import type { DashboardCosts } from '@open-mercato/cezar-api-client'
const at = '2026-09-19T00:00:00.000Z'
function fixture(id = 's1'): DashboardCosts {
  return {
    snapshotId: id,
    asOf: at,
    expiresAt: '2026-09-19T00:01:00.000Z',
    scope: 'retained-task-lifetime',
    period: 'all',
    windowStart: null,
    sort: 'cost',
    visibility: { tokens: true, cost: true },
    coverage: { projects: [{ projectId: 'shop', state: 'complete', omittedRuns: 0 }] },
    invalidDateTasks: 0,
    totals: {
      tasks: 2,
      costUsd: { value: 0.000012, reportedTasks: 1 },
      inputTokens: { value: 0, reportedTasks: 1 },
      outputTokens: { value: null, reportedTasks: 0 },
    },
    series: [],
    projects: [{ projectId: 'shop', tasks: 2, costUsd: { value: 0.000012, reportedTasks: 1 } }],
    tasks: {
      rows: Array.from({ length: 20 }, (_, i) => ({
        projectId: 'shop',
        id: i === 0 ? 'a' : `task-${i}`,
        title: i === 0 ? 'Measured task' : `Task ${i}`,
        status: 'done',
        archived: true,
        subtask: true,
        createdAt: at,
        costUsd: 0,
      })),
      total: 21,
      nextOffset: 20,
    },
  }
}
function setup(visibility = { tokens: true, cost: true }) {
  let data = fixture()
  let detailCost = true
  const history = new Map([[data.snapshotId, structuredClone(data)]])
  let error = false
  let expired = false
  const calls: URL[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = new URL(String(input), 'http://localhost')
      calls.push(url)
      if (error) return new Response('{}', { status: 503 })
      if (expired && url.searchParams.has('snapshotId')) {
        expired = false
        return new Response('{}', { status: 409 })
      }
      const answer = structuredClone(
        history.get(url.searchParams.get('snapshotId') ?? '') ?? data,
      )
      if (url.searchParams.has('snapshotId') && !detailCost) answer.visibility.cost = false
      if (url.searchParams.get('offset') === '20')
        answer.tasks = {
          rows: [{ ...answer.tasks.rows[0]!, id: 'b', title: 'Second task' }],
          total: 21,
          nextOffset: null,
        }
      return new Response(JSON.stringify(answer))
    }),
  )
  const client = createQueryClient()
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <UsageCosts visibility={visibility} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return {
    calls,
    client,
    hideDetailCost: () => {
      detailCost = false
    },
    ...view,
    setVisibility: (next: { tokens: boolean; cost: boolean }) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <UsageCosts visibility={next} />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    setData: (next: ReturnType<typeof fixture>) => {
      data = next
      history.set(next.snapshotId, structuredClone(next))
    },
    update: () => {
      data = fixture('s2')
      data.totals.costUsd!.value = 9
    },
    fail: () => {
      error = true
    },
    expire: () => {
      expired = true
    },
  }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
it('keeps tiny reported USD, measured zero and absent output distinct', async () => {
  setup()
  await screen.findAllByText('$0.000012')
  expect(screen.getByText('Unavailable')).toBeTruthy()
  expect(screen.getByText('0 of 2 tasks report this metric')).toBeTruthy()
  expect(screen.getByText('0')).toBeTruthy()
})
it('does not request or advertise metrics when both capabilities are hidden', async () => {
  const { calls } = setup({ tokens: false, cost: false })
  expect(screen.getByText('Usage metrics are hidden by workspace settings')).toBeTruthy()
  expect(screen.queryByText('Reported USD')).toBeNull()
  expect(calls).toHaveLength(0)
})
it('honors each capability independently', async () => {
  setup({ tokens: true, cost: false })
  await screen.findAllByText('Input tokens')
  expect(screen.queryByText('Reported USD')).toBeNull()
  expect(screen.queryByText('$0.000012')).toBeNull()
})
it('opens project tasks, pages explicitly, and links to project task detail', async () => {
  const { calls } = setup()
  fireEvent.click(await screen.findByRole('button', { name: /shop/ }))
  const sheet = await screen.findByRole('dialog')
  expect(await within(sheet).findByRole('link', { name: 'Measured task' })).toHaveProperty(
    'pathname',
    '/p/shop/tasks/a',
  )
  fireEvent.click(await within(sheet).findByRole('button', { name: 'Show 20 more tasks' }))
  expect(await within(sheet).findByRole('link', { name: 'Second task' })).toBeTruthy()
  expect(
    calls.some(
      (url) =>
        url.searchParams.get('projectId') === 'shop' && url.searchParams.get('offset') === '20',
    ),
  ).toBe(true)
})
it('stages fresh totals until Show and marks retained values stale on errors', async () => {
  const { client, update, fail } = setup()
  await screen.findAllByText('$0.000012')
  update()
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  expect(screen.queryByText('$9.00')).toBeNull()
  fireEvent.click(await screen.findByRole('button', { name: 'Updates available — Show' }))
  expect(screen.getByText('$9.00')).toBeTruthy()
  fail()
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  expect(await screen.findByText(/Showing stale usage/)).toBeTruthy()
  expect(screen.getByText('$9.00')).toBeTruthy()
})
it('replaces expired detail snapshots with a fresh list', async () => {
  const { expire, calls } = setup()
  await screen.findAllByText('$0.000012')
  expire()
  fireEvent.click(screen.getByRole('button', { name: 'View tasks' }))
  expect(await screen.findByRole('link', { name: 'Measured task' })).toBeTruthy()
  await waitFor(() =>
    expect(calls.filter((url) => !url.searchParams.has('snapshotId')).length).toBeGreaterThan(
      1,
    ),
  )
})
it('removes hidden cost values immediately when the server policy changes', async () => {
  const { client, setData } = setup()
  await screen.findAllByText('$0.000012')
  setData({ ...fixture('s2'), visibility: { tokens: true, cost: false } })
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await waitFor(() => expect(screen.queryAllByText('$0.000012')).toHaveLength(0))
  expect(screen.queryByRole('option', { name: 'Reported USD' })).toBeNull()
})
it('keeps current source warnings even when updated totals are staged', async () => {
  const { client, setData } = setup()
  await screen.findAllByText('$0.000012')
  const next = fixture('s2')
  next.coverage.projects[0]!.state = 'unavailable'
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  expect(await screen.findByText('One project is unavailable.')).toBeTruthy()
})
it('disables a deleted task immediately before the next snapshot', async () => {
  const { dashboardTransition } = await import('@/api/dashboard-truth')
  setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const link = await screen.findByRole('link', { name: 'Measured task' })
  act(() => dashboardTransition('shop', 'a'))
  expect(link.getAttribute('aria-disabled')).toBe('true')
})
it('labels created-date cohorts honestly and sends period and metric choices', async () => {
  const { calls } = setup()
  await screen.findAllByText('$0.000012')
  fireEvent.change(screen.getByRole('combobox', { name: 'Tasks created' }), {
    target: { value: '7d' },
  })
  expect(
    await screen.findByText(
      'Lifetime usage of tasks created in this period — not spending during the period.',
    ),
  ).toBeTruthy()
  fireEvent.change(await screen.findByRole('combobox', { name: 'Sort by' }), {
    target: { value: 'output' },
  })
  await waitFor(() =>
    expect(
      calls.some(
        (url) =>
          url.searchParams.get('period') === '7d' && url.searchParams.get('sort') === 'output',
      ),
    ).toBe(true),
  )
})
it('distinguishes an empty retained cohort from tasks lacking reports', async () => {
  const { client, setData } = setup()
  await screen.findAllByText('$0.000012')
  const next = fixture('s3')
  next.totals.costUsd = { value: null, reportedTasks: 0 }
  next.totals.inputTokens = { value: null, reportedTasks: 0 }
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  fireEvent.click(await screen.findByRole('button', { name: 'Updates available — Show' }))
  expect(screen.getByText('No reports for the visible metrics in this cohort.')).toBeTruthy()
  expect(screen.queryByText('No retained tasks in this cohort.')).toBeNull()
})
it('does not announce an unchanged snapshot as an update', async () => {
  const { client, setData } = setup()
  await screen.findAllByText('$0.000012')
  setData(fixture('same-content'))
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await act(() => new Promise((resolve) => setTimeout(resolve, 25)))
  expect(screen.queryByRole('button', { name: 'Updates available — Show' })).toBeNull()
})
it('pages the accepted task snapshot while a fresher candidate awaits Show', async () => {
  const { client, setData, calls } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  const next = fixture('new-snapshot')
  next.tasks.rows[0]!.title = 'Renamed candidate'
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await within(sheet).findByRole('button', { name: 'Updates available — Show' })
  fireEvent.click(within(sheet).getByRole('button', { name: 'Show 20 more tasks' }))
  await within(sheet).findByRole('link', { name: 'Second task' })
  expect(within(sheet).queryByRole('link', { name: 'Renamed candidate' })).toBeNull()
  expect(
    calls
      .filter((url) => url.searchParams.get('offset') === '20')
      .at(-1)
      ?.searchParams.get('snapshotId'),
  ).toBe('s1')
})
it('applies a detail response policy immediately to previously accepted rows', async () => {
  const { client, hideDetailCost } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  expect(within(sheet).getAllByText('Reported USD: $0.00').length).toBe(20)
  hideDetailCost()
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await waitFor(() =>
    expect(within(sheet).queryAllByText('Reported USD: $0.00')).toHaveLength(0),
  )
})
it('keeps an expired paged cohort visible until the fresh replacement is accepted', async () => {
  const { setData, expire } = setup()
  fireEvent.click(await screen.findByRole('button', { name: 'View tasks' }))
  const sheet = await screen.findByRole('dialog')
  await within(sheet).findByRole('link', { name: 'Measured task' })
  const next = fixture('replacement')
  next.tasks.rows[0]!.title = 'Replacement cohort'
  setData(next)
  expire()
  fireEvent.click(within(sheet).getByRole('button', { name: 'Show 20 more tasks' }))
  const show = await within(sheet).findByRole('button', { name: 'Updates available — Show' })
  expect(within(sheet).queryByRole('link', { name: 'Replacement cohort' })).toBeNull()
  fireEvent.click(show)
  expect(await within(sheet).findByRole('link', { name: 'Replacement cohort' })).toBeTruthy()
})
it('masks conflicting cached health and fresh server policies until health reconciles', async () => {
  const { client, setData, setVisibility } = setup({ tokens: true, cost: false })
  await screen.findAllByText('Input tokens')
  const next = fixture('cost-only')
  next.visibility = { tokens: false, cost: true }
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  expect(await screen.findByText('Usage metrics are hidden by workspace settings')).toBeTruthy()
  expect(screen.queryAllByText('$0.000012')).toHaveLength(0)
  setVisibility({ tokens: false, cost: true })
  expect((await screen.findAllByText('$0.000012')).length).toBeGreaterThan(0)
  expect(screen.queryByText('Usage metrics are hidden by workspace settings')).toBeNull()
  expect(screen.queryByText('Input tokens')).toBeNull()
})

it('excludes stale project amounts from export when the latest response hides all metrics', async () => {
  const { client, setData, container } = setup()
  await screen.findAllByText('$0.000012')
  const next = fixture('hidden-export')
  next.visibility = { cost: false, tokens: false }
  setData(next)
  await act(() => client.invalidateQueries({ queryKey: workspaceQueryKeys.dashboard }))
  await screen.findByText('Usage metrics are hidden by workspace settings')
  const rows = [...container.querySelectorAll<HTMLElement>('[data-dashboard-export]')].flatMap(
    (el) => JSON.parse(el.dataset.dashboardExport!),
  )
  expect(rows).toEqual([])
})
