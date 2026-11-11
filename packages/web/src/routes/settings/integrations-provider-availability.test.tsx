import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { setApiScope } from '@open-mercato/cezar-api-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { createQueryClient } from '@/api/query-client'
import { IntegrationsSection } from './integrations-section'

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
    if (url.endsWith('/telegram')) return json({ available: true, notifications: { available: true }, taskControl: { available: true }, receivers: [], bots: [], grants: [] })
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


import { telegramDescriptor } from '@/lib/chat-providers/telegram'
it('gallery panel honors synthetic provider availability guidance', async () => {
 const oldName=telegramDescriptor.name, old=telegramDescriptor.bot.unavailableMessages
 try {
 telegramDescriptor.name='Fixture Chat'
 telegramDescriptor.bot.unavailableMessages={hosted:'Fixture requires a local socket.',unavailable:'Fixture temporarily unavailable.'}
 mount({'/telegram':{available:false,reason:'hosted',notifications:{available:false,reason:'hosted'},taskControl:{available:false,reason:'hosted'},receivers:[],bots:[],grants:[]}},false,true,'/?integration=telegram')
 await screen.findByRole('region',{name:'Fixture Chat'})
 await waitFor(()=>expect(document.body.textContent).toContain('Fixture requires a local socket.'))
 } finally {telegramDescriptor.name=oldName;telegramDescriptor.bot.unavailableMessages=old}
})
