import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionsSection } from './extensions-section'
import { ProjectScopeContext } from '@/api/project-scope-context'
import type { ExtensionRecord } from '@open-mercato/cezar-api-client'

vi.mock('@/api/client', async () => {
  const { hc } = await import('hono/client')
  const legacyRequest = async (path: string, method = 'GET', body?: unknown) => (await fetch(`/api/v1/p/alpha/extensions${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) })).json()
  return {
    getExtensions: () => legacyRequest(''),
    installExtension: (source: string) => legacyRequest('', 'POST', { source }),
    setExtensionEnabled: (id: string, enabled: boolean) => legacyRequest(`/${id}/${enabled ? 'enable' : 'disable'}`, 'POST'),
    cez: hc(''), unwrap: async (response: Response) => {
    const body = await response.json()
    if (!response.ok) throw new Error(body.error)
    return body
  } }
})
const manifest = { id: 'example', name: 'Example', version: '1.0.0', apiVersion: '0.1' as const, entry: 'index.js', permissions: ['project.read' as const], actions: [], panels: [], contributes: { commands: [{ id: 'refresh', label: 'Refresh summary' }], panels: [{ id: 'summary', title: 'Summary', blocks: [], actions: [] }] } }
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
function setup(initial: ExtensionRecord[] = []) {
  let records = initial
  let count = 1
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    let body: unknown
    if (url.endsWith('/prepare-install')) body = { preparedId: 'preview-1', manifest, addedPermissions: ['project.read'] }
    else if (url.endsWith('/commit-install')) { records = [{ manifest, source: '/local/example', installedAt: '', enabled: false }]; body = records[0] }
    else if (url.endsWith('/enable') || url.endsWith('/disable')) { records = records.map(record => ({ ...record, enabled: url.endsWith('/enable') })); body = records[0] }
    else if (init?.method === 'DELETE') { records = []; body = { ok: true } }
    else if (url.endsWith('/invoke')) { count++; body = { ok: true } }
    else if (url.endsWith('/panels/summary')) body = { id: 'summary', title: 'Summary', blocks: [{ type: 'status', label: 'Tasks', value: String(count) }], actions: [{ id: 'refresh', label: 'Refresh panel' }] }
    else body = { extensions: records }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = (projectId: string) => <QueryClientProvider client={client}><ProjectScopeContext.Provider value={{ projectId, apiBase: `/api/v1/p/${projectId}` }}><ExtensionsSection /></ProjectScopeContext.Provider></QueryClientProvider>
  const rendered = render(view('alpha'))
  return { fetch, client, switchProject: (id: string) => rendered.rerender(view(id)) }
}
const record: ExtensionRecord = { manifest, source: '/local/example', installedAt: '', enabled: false }

describe('ExtensionsSection', () => {
  it('previews permissions before installation and separately approves project enablement', async () => {
    const { fetch } = setup()
    fireEvent.change(screen.getByLabelText('Extension folder or package'), { target: { value: '/local/example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview install' }))
    const preview = await screen.findByRole('region', { name: 'Installation preview' })
    expect(within(preview).getByText('Added permissions: project.read')).toBeTruthy()
    expect(within(preview).getByText(/not a security sandbox/)).toBeTruthy()
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/commit-install'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Approve and install' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/enable'))).toBe(false)
    expect(screen.getByRole('region', { name: 'Project access approval' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Approve and enable' }))
    await screen.findByRole('button', { name: 'Disable' })
    expect(fetch.mock.calls.find(([url]) => String(url).endsWith('/commit-install'))?.[1]?.body).toBe(JSON.stringify({ preparedId: 'preview-1' }))
  })
  it('renders enabled contributions, invokes commands and refreshes panel snapshots', async () => {
    const { fetch } = setup([{ ...record, enabled: true }])
    await screen.findByText('1')
    fireEvent.click(screen.getByRole('button', { name: 'Refresh panel' }))
    await screen.findByText('2')
    expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/p/alpha/extensions/example/commands/refresh/invoke')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
    await screen.findByRole('button', { name: 'Enable' })
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
  })
  it('prepares reload from the saved source and preserves data on uninstall', async () => {
    const { fetch } = setup([record])
    fireEvent.click(await screen.findByRole('button', { name: 'Reload / update' }))
    await screen.findByRole('region', { name: 'Installation preview' })
    expect(fetch.mock.calls.find(([url]) => String(url).endsWith('/prepare-install'))?.[1]?.body).toBe(JSON.stringify({ source: record.source }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel install' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    expect(screen.getByText(/data are preserved/)).toBeTruthy()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall and keep data' }))
    await screen.findByText('No extensions installed.')
    expect(fetch.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]).toBe('/api/v1/p/alpha/extensions/example')
  })
  it('isolates cache entries and discards pending approval when switching projects', async () => {
    const { fetch, client, switchProject } = setup([record])
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    switchProject('beta')
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/p/beta/extensions')).toBe(true))
    expect(screen.queryByRole('region', { name: 'Project access approval' })).toBeNull()
    expect(client.getQueryData(['extensions', 'alpha', 'list'])).toBeDefined()
    await waitFor(() => expect(client.getQueryData(['extensions', 'beta', 'list'])).toBeDefined())
  })
  it('shows preparation errors without offering approval', async () => {
    const { fetch } = setup()
    await screen.findByText('No extensions installed.')
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'Invalid manifest' }), { status: 400 }))
    fireEvent.change(screen.getByLabelText('Extension folder or package'), { target: { value: '/broken' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview install' }))
    expect((await screen.findByRole('alert')).textContent).toBe('Invalid manifest')
    expect(screen.queryByRole('button', { name: 'Approve and install' })).toBeNull()
  })
})
