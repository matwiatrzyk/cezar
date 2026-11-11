import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { ExtensionPlacement, HealthResponse } from '@open-mercato/cezar-api-client'

import { isSidebarPanelCollapsed, SidebarExtensionPanels } from './sidebar-panels'

/** The sidebar's extension sections (spec 2026-11-07-extension-placements-v1.1, "Project
 *  sidebar"): nothing without contributions, collapsed by default, the collapse persisted as
 *  workspace ui-state, and a stopped worker reduced to one line and a link. */

const health = (extensions: boolean): HealthResponse => ({
  version: '0.0.0-test',
  runtimeId: '00000000-0000-4000-8000-000000000001',
  projects: [],
  bootProject: 'alpha',
  repoRoot: '/repo',
  repo: { root: '/repo', branch: 'main' },
  checks: [],
  defaultRunner: 'claude',
  forge: null,
  capabilities: { localHandoff: true, terminal: false, designMode: false, tokenMetrics: true, tokenUsageMetrics: true, costMetrics: true, followups: false, singleProject: false, automations: false, webhooks: false, extensions, ...(extensions ? {} : { extensionsUnavailableReason: 'hosted' as const }), dispatch: false },
})

const running: ExtensionPlacement = {
  extensionId: 'example', name: 'Example', status: 'running',
  panels: [{ id: 'summary', title: 'Project summary', location: 'sidebar' }, { id: 'health', title: 'Health', location: 'sidebar' }],
  commands: [],
}
const failed: ExtensionPlacement = { extensionId: 'broken', name: 'Broken', status: 'failed', error: 'worker exited with code 1', panels: [{ id: 'x', title: 'Never shown', location: 'sidebar' }], commands: [] }

let calls: { url: string; init?: RequestInit }[] = []
let uiState: Record<string, unknown> = {}

function stub({ extensions = true, placements = [] as ExtensionPlacement[], panelError = false } = {}) {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/\?$/, '')
    calls.push({ url, init })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url === '/api/v1/health') return json(health(extensions))
    if (url === '/api/v1/workspace/ui-state') {
      if (init?.method === 'PUT') uiState = { ...uiState, ...JSON.parse(String(init.body)) }
      return json(uiState)
    }
    if (url === '/api/v1/p/alpha/extensions/placements?location=sidebar') return json({ available: true, extensions: placements })
    if (url.endsWith('/invoke')) return json({ ok: true, message: 'Summary refreshed' })
    if (url.endsWith('/panels/summary')) {
      return panelError ? json({ error: 'extension panel timed out' }, 400) : json({ id: 'summary', title: 'Project summary', blocks: [{ type: 'status', label: 'Tasks', value: '3' }], actions: [{ id: 'refresh', label: 'Refresh summary' }] })
    }
    if (url.endsWith('/panels/health')) return json({ id: 'health', title: 'Health', text: 'All green', blocks: [], actions: [] })
    return json({ error: `unstubbed ${url}` }, 404)
  }))
}

function renderPanels() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/p/alpha']}>
        <SidebarExtensionPanels projectId="alpha" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const section = (title: string) => screen.queryByRole('region', { name: title })
const disclosure = (title: string) => within(section(title)!).getByRole('button', { name: title })
const requested = (fragment: string) => calls.some((call) => call.url.includes(fragment))

beforeEach(() => { uiState = {} })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

describe('SidebarExtensionPanels', () => {
  it('renders nothing — and asks for nothing — when extensions are off on this cockpit', async () => {
    stub({ extensions: false, placements: [running] })
    const { container } = renderPanels()
    await waitFor(() => expect(requested('/api/v1/health')).toBe(true))
    expect(container.querySelector('[data-slot="sidebar-extension-panels"]')).toBeNull()
    expect(requested('placements')).toBe(false)
  })

  it('renders nothing when no enabled extension contributes a sidebar panel', async () => {
    stub({ placements: [] })
    const { container } = renderPanels()
    await waitFor(() => expect(requested('placements?location=sidebar')).toBe(true))
    expect(container.querySelector('[data-slot="sidebar-extension-panels"]')).toBeNull()
  })

  it('lists each panel as a section, collapsed by default, without fetching its body', async () => {
    stub({ placements: [running] })
    renderPanels()
    await screen.findByRole('region', { name: 'Project summary' })
    expect(section('Health')).not.toBeNull()
    expect(disclosure('Project summary').getAttribute('aria-expanded')).toBe('false')
    expect(section('Project summary')!.getAttribute('data-extension-panel')).toBe('example/summary')
    expect(requested('/panels/summary')).toBe(false)
  })

  it('expands on click, loads the panel, runs its actions and persists the open state as ui-state', async () => {
    stub({ placements: [running] })
    renderPanels()
    await screen.findByRole('region', { name: 'Project summary' })
    // The toggle waits for the ui-state cache, so a write can never drop a sibling key.
    await waitFor(() => expect(disclosure('Project summary').hasAttribute('disabled')).toBe(false))

    fireEvent.click(disclosure('Project summary'))

    await waitFor(() => expect(disclosure('Project summary').getAttribute('aria-expanded')).toBe('true'))
    expect(await screen.findByText('Tasks')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    // The sidebar section already names the panel: the renderer shows no second heading.
    expect(within(section('Project summary')!).queryByRole('heading')).toBeNull()
    const put = calls.find((call) => call.url === '/api/v1/workspace/ui-state' && call.init?.method === 'PUT')
    expect(JSON.parse(String(put?.init?.body))).toEqual({ sidebarExtensionPanels: { collapsed: { 'example/summary': false } } })

    fireEvent.click(screen.getByRole('button', { name: 'Refresh summary' }))
    await waitFor(() => expect(requested('/extensions/example/commands/refresh/invoke')).toBe(true))
    const invoke = calls.find((call) => call.url.endsWith('/invoke'))
    // A sidebar panel passes no task context.
    expect(JSON.parse(String(invoke?.init?.body))).toEqual({})
    const outcome = await screen.findByText('Summary refreshed')
    expect(outcome.closest('[aria-live="polite"]')).not.toBeNull()

    fireEvent.click(disclosure('Project summary'))
    await waitFor(() => expect(disclosure('Project summary').getAttribute('aria-expanded')).toBe('false'))
  })

  it('opens a section the stored ui-state marks open, and keeps sibling keys when writing', async () => {
    uiState = { sidebarExtensionPanels: { collapsed: { 'example/summary': false, 'other/x': false }, future: 1 } }
    stub({ placements: [running] })
    renderPanels()
    expect(await screen.findByText('Tasks')).toBeTruthy()
    expect(disclosure('Project summary').getAttribute('aria-expanded')).toBe('true')
    expect(disclosure('Health').getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(disclosure('Health'))
    expect(await screen.findByText('All green')).toBeTruthy()
    const put = calls.find((call) => call.url === '/api/v1/workspace/ui-state' && call.init?.method === 'PUT')
    expect(JSON.parse(String(put?.init?.body))).toEqual({
      sidebarExtensionPanels: { collapsed: { 'example/summary': false, 'other/x': false, 'example/health': false }, future: 1 },
    })
  })

  it('shows a failed worker as one line with its error and a link to Settings → Extensions', async () => {
    stub({ placements: [failed, running] })
    renderPanels()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Broken: worker exited with code 1')
    expect(screen.getByRole('link', { name: 'Open Settings → Extensions' }).getAttribute('href')).toBe(`/settings/global/extensions?project=alpha&extension=${failed.extensionId}`)
    // Its panels are not offered: a stopped worker cannot answer.
    expect(section('Never shown')).toBeNull()
    expect(section('Project summary')).not.toBeNull()
  })

  it('keeps a panel error inside its own section, with a retry', async () => {
    uiState = { sidebarExtensionPanels: { collapsed: { 'example/summary': false } } }
    stub({ placements: [running], panelError: true })
    renderPanels()
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('extension panel timed out')
    expect(within(section('Project summary')!).getByRole('button', { name: 'Retry panel' })).toBeTruthy()
    expect(section('Health')).not.toBeNull()
  })
})

describe('isSidebarPanelCollapsed', () => {
  it('defaults to collapsed and honours an explicit stored answer either way', () => {
    expect(isSidebarPanelCollapsed(undefined, 'a/b')).toBe(true)
    expect(isSidebarPanelCollapsed({}, 'a/b')).toBe(true)
    expect(isSidebarPanelCollapsed({ sidebarExtensionPanels: { collapsed: { 'a/b': false } } }, 'a/b')).toBe(false)
    expect(isSidebarPanelCollapsed({ sidebarExtensionPanels: { collapsed: { 'a/b': true } } }, 'a/b')).toBe(true)
  })
})
