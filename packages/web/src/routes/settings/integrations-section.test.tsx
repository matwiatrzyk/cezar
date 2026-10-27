import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, useLocation, Routes, Route } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { IntegrationsSection, LegacyWebhooksRedirect } from './integrations-section'

const jira = { kind: 'jira', connectionId: 'connection-1', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' }, externalId: '100', externalName: 'Platform' }
const connection = { id: 'connection-1', kind: 'jira', origin: 'https://acme.atlassian.net', email: 'user@example.com' }
const installed = { configFile: 'e2e.config.ts', workflow: true, credentials: [], setup: null }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
function mount(overrides: Record<string, unknown> = {}, offline = false, enabled = false, initialEntry = '/') {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (offline) return json({ error: 'Offline' }, 503)
    const url = String(input)
    const suffix = Object.keys(overrides).find(key => url.endsWith(key))
    if (suffix) return json(overrides[suffix])
    if (url.endsWith('/tracker/association')) return json({ association: jira })
    if (url.endsWith('/tracker/connection')) return json({ connection, demo: false })
    if (url.endsWith('/e2e')) return json(installed)
    return json({ error: 'Unexpected request' }, 404)
  })
  vi.stubGlobal('fetch', fetch)
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  for (const project of ['alpha', 'beta']) client.setQueryData([project, 'health'], { capabilities: { webhooks: enabled } })
  const tree = (projectId: string) => <QueryClientProvider client={client}><MemoryRouter initialEntries={[initialEntry]}><ProjectScopeProvider projectId={projectId}><IntegrationsSection /></ProjectScopeProvider></MemoryRouter></QueryClientProvider>
  const view = render(tree('alpha'))
  return { fetch, client, switchProject: () => view.rerender(tree('beta')) }
}

afterEach(() => { cleanup(); setApiScope(null); vi.unstubAllGlobals() })

describe('Integrations gallery', () => {
  it('shows Jira and TesterArmy together and opens only the selected provider configuration', async () => {
    mount()
    const inUse = await screen.findByRole('region', { name: 'In use' })
    await waitFor(() => expect(within(inUse).getAllByRole('button')).toHaveLength(2))
    expect(within(inUse).getByText('Connected')).toBeTruthy()
    expect(within(inUse).getByText('Installed')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Jira' }))
    const panel = await screen.findByRole('dialog', { name: 'Jira' })
    expect(within(panel).getByRole('button', { name: 'Replace Jira credentials' })).toBeTruthy()
    expect(within(panel).queryByRole('button', { name: /Linear credentials/ })).toBeNull()
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Configure Linear' }))
    const linear = await screen.findByRole('dialog', { name: 'Linear' })
    expect(within(linear).getByText(/replaces the issue source/)).toBeTruthy()
    expect(within(linear).queryByRole('button', { name: 'Disconnect' })).toBeNull()
    expect(within(linear).queryByRole('button', { name: 'Remove project credentials' })).toBeNull()
  })

  it('keeps the panel open when connecting moves a card into In use', async () => {
    const { client } = mount({ '/tracker/association': { association: null }, '/tracker/connection': { connection: null, demo: true } })
    await waitFor(() => expect(screen.getAllByText('Not connected')).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Configure Jira' }))
    await screen.findByRole('dialog', { name: 'Jira' })
    act(() => { client.setQueryData(['tracker', 'alpha', 'association'], { association: jira }) })
    await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy())
    expect(screen.getByRole('dialog', { name: 'Jira' })).toBeTruthy()
  })

  it('discards open credential forms when the project changes', async () => {
    const { switchProject } = mount()
    await screen.findByText('Connected')
    fireEvent.click(screen.getByRole('button', { name: 'Configure Jira' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Replace Jira credentials' }))
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'unsaved-test-value' } })
    switchProject()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Configure Jira' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Replace Jira credentials' }))
    expect((screen.getByLabelText('API token') as HTMLInputElement).value).toBe('')
  })

  it('does not report unavailable or mismatched connections as connected', async () => {
    mount({ '/tracker/connection': { connection: { ...connection, id: 'different' }, demo: false } })
    await screen.findByText('Reconnect')
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('offers retry for unavailable status without claiming tools are disconnected', async () => {
    const { fetch } = mount({}, true)
    await screen.findByRole('button', { name: 'Retry' })
    expect(screen.queryByText('Not connected')).toBeNull()
    expect(screen.queryByText('Not set up')).toBeNull()
    expect(screen.getAllByText('Status unavailable')).toHaveLength(3)
    fetch.mockImplementation(async input => String(input).endsWith('/e2e') ? json(installed) : String(input).endsWith('/tracker/association') ? json({ association: jira }) : json({ connection, demo: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('Connected')
    await screen.findByText('Installed')
  })

  it('shows setup awaiting merge and opens the real TesterArmy setup form', async () => {
    mount({ '/e2e': { ...installed, configFile: null, workflow: false, setup: { runId: 'setup-1', status: 'done' } } })
    await screen.findByText('Awaiting merge')
    fireEvent.click(screen.getByRole('button', { name: 'Configure TesterArmy e2e' }))
    const panel = await screen.findByRole('dialog', { name: 'TesterArmy e2e' })
    expect(within(panel).getByRole('button', { name: 'Set up e2e' })).toBeTruthy()
    expect(within(panel).getByRole('link', { name: 'Open the setup task' })).toBeTruthy()
  })
})

const receiver = (id: string, format: string) => ({
  kind: 'live', id, name: id, format, destination: 'https://example.com/…', state: 'active',
  revision: 1, deliveryRevision: 1, profile: 'minimal', preset: 'attention', events: [],
  scope: 'every_task', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false,
  pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'success', activationBlocked: false,
})

it('groups multiple notification receivers by tool and opens a provider-specific add form', async () => {
  mount({ '/webhooks': { receivers: [receiver('slack-one', 'slack.v1'), receiver('slack-two', 'slack.v1'), receiver('discord-one', 'discord.v1'), receiver('custom-one', 'cezar.json.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Configure Slack' }).textContent).toContain('2 active'))
  fireEvent.click(screen.getByRole('button', { name: 'Configure Slack' }))
  expect(await screen.findByRole('heading', { name: /slack-one/ })).toBeTruthy()
  expect(screen.getByRole('heading', { name: /slack-two/ })).toBeTruthy()
  expect(screen.queryByRole('heading', { name: /discord-one|custom-one/ })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
  expect((screen.getByLabelText('Destination') as HTMLSelectElement).value).toBe('slack.v1')
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }))
  fireEvent.click(screen.getByRole('button', { name: 'All integrations' }))
  fireEvent.click(screen.getByRole('button', { name: 'Configure Discord' }))
  expect(await screen.findByRole('heading', { name: /discord-one/ })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
  expect((screen.getByLabelText('Destination') as HTMLSelectElement).value).toBe('discord.v1')
})

it('keeps notification integrations visible when delivery is off and makes no receiver request', async () => {
  const { fetch } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Configure Slack' }))
  expect(await screen.findByText('Webhooks are off')).toBeTruthy()
  expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/webhooks'))).toBe(false)
})

it('redirects old receiver links into integrations without losing project, tab or hash', async () => {
  function Location() { const location = useLocation(); return <output>{location.pathname + location.search + location.hash}</output> }
  render(<MemoryRouter initialEntries={['/p/alpha/settings/webhooks?endpoint=abc&tab=activity#details']}><Routes>
    <Route path="/p/:id/settings/webhooks" element={<LegacyWebhooksRedirect />} />
    <Route path="/p/:id/settings/integrations" element={<Location />} />
  </Routes></MemoryRouter>)
  expect(await screen.findByText('/p/alpha/settings/integrations?endpoint=abc&tab=activity&integration=webhooks#details')).toBeTruthy()
})

it('opens an old Slack receiver settings link even when it lands through the Webhooks card', async () => {
  mount({ '/webhooks': { receivers: [receiver('slack-one', 'slack.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } } }, false, true, '/p/alpha/settings/integrations?integration=webhooks&endpoint=slack-one&tab=settings')
  expect(await screen.findByRole('dialog', { name: 'Edit receiver' })).toBeTruthy()
  expect((screen.getByLabelText('Destination') as HTMLSelectElement).value).toBe('slack.v1')
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('slack-one')
})
