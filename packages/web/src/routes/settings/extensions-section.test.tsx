import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { ExtensionsSection, extensionSourceLabel } from './extensions-section'
import { ProjectScopeContext } from '@/api/project-scope-context'
import type { ExtensionForm, ExtensionRecord } from '@open-mercato/cezar-api-client'

const health = vi.hoisted(() => ({ current: undefined as unknown, returnTo: null as null | { pathname: string; search: string; hash: string } }))
vi.mock('@/lib/settings-return', () => ({ settingsReturnLocation: () => health.returnTo }))
vi.mock('@/api/client', async () => {
  const { hc } = await import('hono/client')
  return {
    getHealth: async () => { if (!health.current) throw new Error('no health'); return health.current },
    getProjects: async () => ({ bootProject: 'alpha', projectsDir: '/p', projects: [
      { id: 'alpha', name: 'Alpha app', root: '/a', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
      { id: 'beta', name: 'Beta app', root: '/b', addedAt: '', lastOpenedAt: '', source: 'local', status: 'ok' },
    ] }),
    cez: hc(''), unwrap: async (response: Response) => {
    const body = await response.json()
    if (!response.ok) throw new Error(body.error)
    return body
  } }
})
const manifest = { id: 'example', name: 'Example', version: '1.0.0', apiVersion: '0.1' as const, entry: 'index.js', permissions: ['project.read' as const], actions: [], panels: [], contributes: { forms: [], chatProviders: [], commands: [{ id: 'refresh', label: 'Refresh summary' }], panels: [{ id: 'summary', title: 'Summary', blocks: [], actions: [] }] } }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); health.current = undefined; health.returnTo = null })
function setup(initial: ExtensionRecord[] = [], scope: string | null = 'alpha', replaces?: unknown, proposals: unknown[] = []) {
  let records = initial
  let count = 1
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input).replace(/\?$/, '') // an empty typed query appends a bare `?`
    let body: unknown
    if ((url.endsWith('/prepare-install') || url.endsWith('/prepare-update'))) body = { preparedId: 'preview-1', manifest, addedPermissions: ['project.read'], addedCapabilities: ['commands'], ...(replaces ? { replaces } : {}) }
    else if (url.endsWith('/commit-install')) { records = [{ manifest, source: '/local/example', installedAt: '', enabled: false }]; body = records[0] }
    else if (url.endsWith('/enable') || url.endsWith('/disable')) { records = records.map(record => ({ ...record, enabled: url.endsWith('/enable') })); body = records[0] }
    else if (init?.method === 'DELETE') { records = []; body = { ok: true } }
    else if (url.endsWith('/invoke')) { count++; body = { ok: true, ...(proposals.length ? { proposals } : {}) } }
    else if (url.endsWith('/panels/summary')) body = { id: 'summary', title: 'Summary', blocks: [{ type: 'status', label: 'Tasks', value: String(count) }], actions: [{ id: 'refresh', label: 'Refresh panel' }] }
    else body = { extensions: records }
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const view = (projectId: string | null) => <QueryClientProvider client={client}><ProjectScopeContext.Provider value={projectId ? { projectId, apiBase: `/api/v1/p/${projectId}` } : { projectId: null, apiBase: '/api/v1' }}><MemoryRouter><ExtensionsSection /></MemoryRouter></ProjectScopeContext.Provider></QueryClientProvider>
  const rendered = render(view(scope))
  return { fetch, client, switchProject: (id: string) => rendered.rerender(view(id)) }
}
const record: ExtensionRecord = { manifest, source: '/local/example', installedAt: '', enabled: false }

describe('ExtensionsSection', () => {
  it('labels extension origins without treating a local path as public or bundled', () => {
    expect(extensionSourceLabel('bundled:telegram')).toBe('Bundled with Cezar')
    expect(extensionSourceLabel('/opt/cezar/dist/bundled-chat/slack/index.js')).toBe('Bundled with Cezar')
    expect(extensionSourceLabel('@open-mercato/example-chat')).toBe('Public extension')
    expect(extensionSourceLabel('@open-mercato/example-chat@^1.2.3')).toBe('Public extension')
    expect(extensionSourceLabel('example-chat@~1.2.3')).toBe('Public extension')
    expect(extensionSourceLabel('/home/me/example-chat')).toBe('Local extension')
  })

  it('previews permissions before installation and separately approves project enablement', async () => {
    const { fetch } = setup()
    fireEvent.change(screen.getByLabelText('Extension folder or package'), { target: { value: '/local/example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview install' }))
    const preview = await screen.findByRole('dialog', { name: /Install Example/ })
    expect(within(preview).getByText('Added permissions: project.read')).toBeTruthy()
    expect(within(preview).getByText('Added capabilities: commands')).toBeTruthy()
    expect(within(preview).getByText(/Installing does not enable it for any project/)).toBeTruthy()
    expect(within(preview).getByText(/not a security sandbox/)).toBeTruthy()
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/commit-install'))).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Approve and install' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/enable'))).toBe(false)
    expect(screen.getByRole('dialog', { name: /Enable Example/ })).toBeTruthy()
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
    await screen.findByRole('dialog', { name: /Install Example/ })
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/example/prepare-update'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel install' }))
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Uninstall Example?' })
    expect(within(confirm).getByText(/data are preserved/)).toBeTruthy()
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Uninstall and keep data' }))
    await screen.findByText('No extensions installed')
    expect(fetch.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]).toBe('/api/v1/extensions/example?removeData=false')
  })
  it('isolates cache entries and discards pending approval when switching projects', async () => {
    const { fetch, client, switchProject } = setup([record])
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    switchProject('beta')
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/p/beta/extensions/access')).toBe(true))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(client.getQueryData(['extensions', 'alpha', 'list'])).toBeDefined()
    await waitFor(() => expect(client.getQueryData(['extensions', 'beta', 'list'])).toBeDefined())
  })
  it('shows preparation errors without offering approval', async () => {
    const { fetch } = setup()
    await screen.findByText('No extensions installed')
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ error: 'Invalid manifest' }), { status: 400 }))
    fireEvent.change(screen.getByLabelText('Extension folder or package'), { target: { value: '/broken' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview install' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('Invalid manifest')
    expect(alert.className).toContain('text-danger')
    expect(screen.queryByRole('button', { name: 'Approve and install' })).toBeNull()
    // Starting another operation clears the stale failure.
    fireEvent.change(screen.getByLabelText('Extension folder or package'), { target: { value: '/local/example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Preview install' }))
    await screen.findByRole('dialog', { name: /Install Example/ })
    expect(screen.queryByText('Invalid manifest')).toBeNull()
  })
  it('moves focus into the consent dialog when enabling', async () => {
    setup([record])
    fireEvent.click(await screen.findByRole('button', { name: 'Enable' }))
    const dialog = await screen.findByRole('dialog', { name: /Enable Example/ })
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
  })
  it('never carries the delete-data choice from one uninstall target to the next', async () => {
    const other: ExtensionRecord = { ...record, manifest: { ...manifest, id: 'other', name: 'Other' } }
    setup([record, other])
    const first = await screen.findByRole('listitem', { name: 'Example' })
    fireEvent.click(within(first).getByRole('button', { name: 'Uninstall' }))
    const confirm = await screen.findByRole('alertdialog', { name: 'Uninstall Example?' })
    fireEvent.click(within(confirm).getByRole('checkbox'))
    expect(within(confirm).getByRole('button', { name: 'Uninstall and delete data' })).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    fireEvent.click(within(screen.getByRole('listitem', { name: 'Other' })).getByRole('button', { name: 'Uninstall' }))
    const second = await screen.findByRole('alertdialog', { name: 'Uninstall Other?' })
    expect((within(second).getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
    expect(within(second).getByRole('button', { name: 'Uninstall and keep data' })).toBeTruthy()
  })
  it('says what a replacement does to the projects running it (M2, L5)', async () => {
    setup([record], 'alpha', { version: '0.9.0', sourceChanged: true, keepsConsent: false, enabledProjects: 3 })
    fireEvent.click(await screen.findByRole('button', { name: 'Reload / update' }))
    const preview = await screen.findByRole('dialog', { name: /Install Example/ })
    expect(within(preview).getByText(/Replaces version 0\.9\.0 from a different source\. It will be disabled in 3 projects until you approve it again\./)).toBeTruthy()
    expect(within(preview).queryByText(/does not enable it/)).toBeNull()
    cleanup()
    setup([record], 'alpha', { version: '0.9.0', sourceChanged: false, keepsConsent: true, enabledProjects: 1 })
    fireEvent.click(await screen.findByRole('button', { name: 'Reload / update' }))
    expect(within(await screen.findByRole('dialog', { name: /Install Example/ })).getByText(/It stays enabled in 1 project and restarts on this version/)).toBeTruthy()
  })
  it('does not query live forms or panels of a failed worker (M3)', async () => {
    const { fetch } = setup([{ ...record, enabled: true, status: 'failed', error: 'extension process exited' }])
    await screen.findByRole('button', { name: 'Review and retry' })
    expect(fetch.mock.calls.some(([url]) => /\/panels\/|\/forms/.test(String(url)))).toBe(false)
    expect(screen.queryByRole('button', { name: 'Refresh summary' })).toBeNull()
  })
  it('shows the extension status as a labelled pill', async () => {
    setup([{ ...record, enabled: true, status: 'starting' }])
    const row = await screen.findByRole('listitem', { name: 'Example' })
    expect(within(row).getByText('Starting').closest('[data-slot="pill"]')).toBeTruthy()
    expect(within(row).queryByText(/starting/)).toBeNull()
  })
  it('names projects instead of showing raw ids and lists the current project once', async () => {
    setup([], null)
    const select = await screen.findByRole('combobox', { name: 'Project access' })
    await waitFor(() => expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Alpha app (current)', 'Beta app']))
    expect(await screen.findByText(/approve access for Alpha app/)).toBeTruthy()
    expect(screen.queryByText(/project default/)).toBeNull()
  })
})

describe('ExtensionsSection — availability and feedback', () => {
  const offHealth = (reason: 'flag_off' | 'hosted') => ({ version: '1', capabilities: { localHandoff: reason !== 'hosted', extensions: false, extensionsUnavailableReason: reason } })
  it.each([['flag_off', /CEZ_EXTENSIONS=0 turns them off\. Restart cezar without it/], ['hosted', /only on a local cockpit/]] as const)('says extensions are off (%s) instead of offering install, enable or run', async (reason, copy) => {
    health.current = offHealth(reason)
    const { fetch } = setup([{ ...record, enabled: true, status: 'running' }, { ...record, manifest: { ...manifest, id: 'other', name: 'Other' }, enabled: false }])
    const note = await screen.findByRole('note')
    expect(note.textContent).toMatch(/Extensions are off on this server/)
    expect(note.textContent).toMatch(copy)
    expect(screen.queryByLabelText('Extension folder or package')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Preview install' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Choose local folder' })).toBeNull()
    const running = await screen.findByRole('listitem', { name: 'Example' })
    expect(within(running).getByText('Enabled · not running')).toBeTruthy()
    expect(within(running).queryByText('Running')).toBeNull()
    for (const name of ['Enable', 'Reload / update', 'Uninstall', 'Refresh summary']) expect(screen.queryByRole('button', { name })).toBeNull()
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/panels/'))).toBe(false)
    // Disabling only removes consent, so it stays possible.
    fireEvent.click(within(running).getByRole('button', { name: 'Disable' }))
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/example/disable'))).toBe(true))
  })
  it('keeps install available when the server reports extensions on', async () => {
    health.current = { version: '1', capabilities: { localHandoff: true, extensions: true } }
    setup()
    expect(await screen.findByRole('button', { name: 'Preview install' })).toBeTruthy()
    expect(screen.queryByText(/Extensions are off/)).toBeNull()
  })
  it('defaults project access to the project the user came from', async () => {
    health.returnTo = { pathname: '/p/beta/tasks', search: '', hash: '' }
    const { fetch } = setup([], null)
    const select = await screen.findByRole('combobox', { name: 'Project access' })
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe('beta'))
    expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual(['Alpha app', 'Beta app (current)'])
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url) === '/api/v1/p/beta/extensions/access')).toBe(true))
  })
  it('says where extensions come from when none is installed', async () => {
    setup()
    const empty = (await screen.findByText('No extensions installed')).parentElement!
    expect(empty.textContent).toMatch(/npm package or a built local folder/)
    expect(empty.textContent).toMatch(/@open-mercato\/cezar-extension-sdk/)
  })
  it('renders only Settings-located panels and commands; other placements live in their surfaces', async () => {
    const placed = { ...manifest, contributes: { ...manifest.contributes, commands: [{ id: 'refresh', label: 'Refresh summary', location: 'palette' as const }], panels: [{ id: 'summary', title: 'Summary', blocks: [], actions: [], location: 'task' as const }] } }
    const { fetch } = setup([{ ...record, manifest: placed, enabled: true }])
    await screen.findByRole('listitem', { name: 'Example' })
    expect(screen.queryByRole('button', { name: 'Refresh summary' })).toBeNull()
    expect(screen.queryByRole('region', { name: 'Summary' })).toBeNull()
    expect(fetch.mock.calls.some(([url]) => String(url).includes('/panels/summary'))).toBe(false)
  })
  it('confirms a command that proposes nothing, in its own row', async () => {
    setup([{ ...record, enabled: true }])
    const row = await screen.findByRole('listitem', { name: 'Example' })
    fireEvent.click(within(row).getByRole('button', { name: 'Refresh summary' }))
    expect((await within(row).findByRole('status')).textContent).toBe('Done. No tasks were proposed.')
    expect(row.querySelector('[aria-live="polite"]')).toBeTruthy()
  })
  it('shows proposals in the producing row, moves focus to them and lets them be dismissed', async () => {
    setup([{ ...record, enabled: true }], 'alpha', undefined, [{ title: 'Fix the flaky test', prompt: 'Fix it' }])
    const row = await screen.findByRole('listitem', { name: 'Example' })
    fireEvent.click(within(row).getByRole('button', { name: 'Refresh summary' }))
    const heading = await within(row).findByRole('heading', { name: 'Proposed task' })
    await waitFor(() => expect(document.activeElement).toBe(heading))
    expect(within(row).getByRole('region', { name: 'Proposed task' }).textContent).toMatch(/Fix the flaky test/)
    expect(within(row).getByRole('link', { name: 'Review task before starting' }).getAttribute('href')).toMatch(/^\/p\/alpha\//)
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss' }))
    expect(within(row).queryByRole('region', { name: 'Proposed task' })).toBeNull()
  })
})

it.each([false, true])('reconciles a form save when the canonical refetch fails=%s', async failRefresh => {
  const form: ExtensionForm = { id: 'prefs', title: 'Preferences', commandId: 'save', fields: [
    { key: 'name', label: 'Display name', type: 'text', required: false },
    { key: 'token', label: 'Access token', type: 'password', required: false },
  ], values: { name: 'saved' } }
  const { fetch } = setup([{ ...record, enabled: true, manifest: { ...manifest, contributes: { ...manifest.contributes, forms: [form] } } }])
  const other = fetch.getMockImplementation()!
  let saved = false
  fetch.mockImplementation(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/forms')) return new Response(JSON.stringify(saved && failRefresh ? { error: 'Refresh unavailable' } : { forms: [form] }), { status: saved && failRefresh ? 503 : 200 })
    if (url.endsWith('/commands/save/invoke')) { saved = true; return new Response(JSON.stringify({ ok: true })) }
    return other(input, init)
  })
  await screen.findByLabelText('Display name')
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: ' SAVED ' } })
  fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'new-secret' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save Preferences' }))
  if (failRefresh) await screen.findByText('Refresh unavailable')
  await waitFor(() => expect(screen.getByLabelText('Display name')).toHaveProperty('value', failRefresh ? ' SAVED ' : 'saved'))
  await waitFor(() => expect(screen.getByLabelText('Access token')).toHaveProperty('value', ''))
  expect(screen.getByRole('button', { name: 'Save Preferences' })).toHaveProperty('disabled', false)
})
