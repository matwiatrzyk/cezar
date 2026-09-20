import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { dashboardLive } from '@/api/dashboard-live'
import { DashboardRoute } from './index'
import type { DashboardTaskRow, DashboardSnapshot } from '@open-mercato/cezar-api-client'
const at = '2026-09-18T00:00:00.000Z'
const row = (id: string, status: 'waiting' | 'review' = 'waiting'): DashboardTaskRow => ({
  projectId: 'shop',
  id,
  title: `Task ${id}`,
  status,
  createdAt: at,
  archived: false,
  workflow: 'quick',
})
const snapshot = (): DashboardSnapshot => ({
  snapshotId: 's1',
  asOf: at,
  expiresAt: '2026-09-18T00:01:00.000Z',
  coverage: { projects: [{ projectId: 'shop', state: 'complete', omittedRuns: 0 }] },
  counts: { running: 0, monitoring: 0, questions: 1, reviews: 1, queued: 0, scheduled: 0 },
  questions: { rows: [row('question')], total: 1, nextOffset: null },
  reviews: { rows: [row('review', 'review')], total: 1, nextOffset: null },
})
function Location() {
  return <output data-testid="location">{useLocation().search}</output>
}
function setup(options: { hidden?: boolean; error?: boolean; saveError?: boolean } = {}) {
  const calls: { url: string; body?: string }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, body: init?.body as string | undefined })
      if (url.includes('/ui-state'))
        return new Response(
          JSON.stringify(
            init?.method === 'PUT'
              ? JSON.parse(init.body as string)
              : {
                  dashboard: {
                    future: 'preserve',
                    tiles: {
                      fleet: true,
                      needsYou: !options.hidden,
                      recent: false,
                      usage: false,
                    },
                  },
                },
          ),
          { status: options.saveError && init?.method === 'PUT' ? 500 : 200 },
        )
      if (url.includes('/dashboard/overview'))
        return new Response(
          JSON.stringify({
            snapshotId: 's1',
            asOf: at,
            windowStart: at,
            period: '7d',
            coverage: snapshot().coverage,
            metrics: {
              running: 1,
              needsYou: 2,
              completed: 0,
              failed: 0,
              timedTasks: 0,
              medianCycleHours: null,
            },
            projects: [],
            page: { rows: [], total: 0, nextOffset: null },
          }),
        )
      if (url.includes('/dashboard/tasks'))
        return new Response(
          JSON.stringify({
            snapshotId: 's1',
            asOf: at,
            coverage: snapshot().coverage,
            page: {
              rows: [row('question'), row('review', 'review')],
              total: 2,
              nextOffset: null,
            },
          }),
        )
      if (url.includes('/dashboard/telemetry'))
        return new Response(JSON.stringify({ asOf: at, samples: [] }))
      if (url.endsWith('/dashboard'))
        return new Response(JSON.stringify(options.error ? { error: 'Offline' } : snapshot()), {
          status: options.error ? 503 : 200,
        })
      if (url.includes('/projects'))
        return new Response(JSON.stringify({ projects: [], bootProject: 'shop' }))
      return new Response(
        JSON.stringify({
          asOf: at,
          windowStart: at,
          filter: 'all',
          rows: [],
          sources: [],
          coverage: snapshot().coverage,
          truncated: false,
        }),
      )
    }),
  )
  const client = createQueryClient()
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dashboard?view=operations']}>
        <DashboardRoute />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { calls, client }
}
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
describe('dashboard decisions', () => {
  it('groups questions and reviews with correct project links and opens the visible queue in a Sheet', async () => {
    setup()
    await screen.findByText('Needs you · 2')
    expect(screen.getByRole('link', { name: 'Task question' }).getAttribute('href')).toBe(
      '/p/shop/tasks/question',
    )
    expect(screen.getByText('Questions · 1')).toBeTruthy()
    expect(screen.getByText('Reviews · 1')).toBeTruthy()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    })
    fireEvent.click(screen.getByRole('button', { name: 'Needs you: 2' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
  })
  it('opens a hidden queue in a Sheet without changing shared preferences', async () => {
    const { calls } = setup({ hidden: true })
    await screen.findByRole('button', { name: 'Needs you: 2' })
    await waitFor(() => expect(screen.queryByText('Needs you · 2')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Needs you: 2' }))
    expect(await screen.findByRole('dialog')).toBeTruthy()
    expect(await screen.findByRole('link', { name: 'Task question' })).toBeTruthy()
    expect(screen.getByTestId('location').textContent).toBe('?view=operations&panel=needs-you')
    expect(calls.some((c) => c.body)).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(screen.getByTestId('location').textContent).toBe('?view=operations')
  })
  it('shows an API error rather than an empty queue', async () => {
    setup({ error: true })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByText('All caught up — no tasks need your input')).toBeNull()
  })
  it('keeps a failed preference save local and offers retry', async () => {
    const { calls } = setup({ saveError: true })
    await screen.findByText('Needs you · 2')
    fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Needs you' }))
    expect(await screen.findByText(/Layout changed for this session/)).toBeTruthy()
    expect(screen.queryByText('Needs you · 2')).toBeNull()
    const body = calls.find((c) => c.body)?.body
    expect(JSON.parse(body!).dashboard).toEqual({
      order: [
        'overview',
        'needsYou',
        'recent',
        'fleet',
        'automations',
        'portfolio',
        'usage',
        'trends',
      ],
      future: 'preserve',
      tiles: {
        automations: true,
        fleet: true,
        needsYou: false,
        recent: false,
        usage: false,
        trends: true,
      },
    })
  })
  it('never calls disconnected task state live', async () => {
    act(() => dashboardLive.connected(false))
    setup()
    expect(await screen.findByText(/Tasks disconnected · Last updated/)).toBeTruthy()
  })
})
it('renders usage alone when action and feed tiles are hidden, then unmounts on hide', async () => {
  const client = createQueryClient()
  client.setQueryData(['workspace', 'ui-state'], {
    dashboard: {
      tiles: { fleet: false, needsYou: false, recent: false, usage: true, trends: false },
    },
  })
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/ui-state'))
        return new Response(
          JSON.stringify({
            dashboard: {
              tiles: {
                fleet: false,
                needsYou: false,
                recent: false,
                usage: true,
                trends: false,
              },
            },
          }),
        )
      if (url.includes('/projects'))
        return new Response(JSON.stringify({ projects: [], bootProject: 'shop' }))
      return new Response('{}', { status: 503 })
    }),
  )
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/dashboard?view=costs']}>
        <DashboardRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  expect(await screen.findByRole('heading', { name: 'Usage & cost' })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Queue & scheduling' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Usage & cost' }))
  expect(screen.queryByRole('heading', { name: 'Usage & cost' })).toBeNull()
  expect(await screen.findByText('All modules in this view are hidden')).toBeTruthy()
  expect(calls.some((url) => url.includes('/dashboard/costs'))).toBe(true)
})

it('restores all modules and closes Customize', async () => {
  const { calls } = setup({ hidden: true })
  await screen.findByRole('button', { name: 'Needs you: 2' })
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show all in Overview' }))
  await waitFor(() => expect(screen.queryByRole('checkbox')).toBeNull())
  await waitFor(() => expect(calls.some((c) => c.body)).toBe(true))
  expect(JSON.parse(calls.find((c) => c.body)!.body!).dashboard.tiles).toEqual({
    automations: true,
    fleet: true,
    needsYou: true,
    recent: true,
    usage: false,
    trends: true,
  })
  fireEvent.click(screen.getByRole('button', { name: 'Customize' }))
  expect(screen.queryByRole('button', { name: 'Show all in Overview' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Reset Overview order' })).toBeNull()
})

it('exports queue counts without duplicating overview attention counts', async () => {
  setup({ hidden: true })
  await screen.findByRole('button', { name: 'Needs you: 2' })
  await screen.findByRole('heading', { name: 'Queue & scheduling' })
  const module = document.querySelector('[data-dashboard-module="fleet"]')!
  const rows = [...module.querySelectorAll<HTMLElement>('[data-dashboard-export]')].flatMap(
    (el) => JSON.parse(el.dataset.dashboardExport!),
  )
  expect(rows.some((row) => ['needsYou', 'running'].includes(row.metric))).toBe(false)
  expect(rows.some((row) => row.metric === 'queued')).toBe(true)
  expect(rows.some((row) => ['questions', 'reviews'].includes(row.metric))).toBe(false)
})

it('keeps legacy Operations links on Overview and only reads telemetry when expanded', async () => {
  const { calls } = setup()
  await screen.findByRole('heading', { name: 'Queue & scheduling' })
  expect(screen.queryByRole('link', { name: 'Operations' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe(
    'page',
  )
  expect(calls.some((c) => c.url.includes('/dashboard/telemetry'))).toBe(false)
  const details = screen.getByText('Technical details').closest('details')!
  details.open = true
  fireEvent(details, new Event('toggle'))
  await waitFor(() =>
    expect(calls.some((c) => c.url.includes('/dashboard/telemetry'))).toBe(true),
  )
})
