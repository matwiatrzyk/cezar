import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Routes, Route } from 'react-router'
import { ProjectScopeProvider } from '../src/api/project-scope-context'
import { ExtensionsSection } from '../src/routes/settings/extensions-section'
import { IntegrationsSection } from '../src/routes/settings/integrations-section'
import '../src/styles/index.css'

// Browser fixture: production components, isolated query state, no real server or extensions.
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
for (const id of ['alpha', 'default']) client.setQueryData([id, 'health'], { capabilities: { extensions: true, webhooks: false } })
client.setQueryData(['workspace', 'projects'], { bootProject: 'alpha', projects: [
  { id: 'alpha', name: 'Alpha app' }, { id: 'beta', name: 'Beta app' },
] })
const initial = new URLSearchParams(location.search).get('recovery')
  ? '/p/alpha/settings/integrations?integration=example%2Fchat' : '/settings/global/extensions'
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}><MemoryRouter initialEntries={[initial]}><Routes>
    <Route path="/settings/global/extensions" element={<ProjectScopeProvider projectId={null}><ExtensionsSection /></ProjectScopeProvider>} />
    <Route path="/p/:projectId/settings/integrations" element={<ProjectScopeProvider projectId="alpha"><IntegrationsSection /></ProjectScopeProvider>} />
  </Routes></MemoryRouter></QueryClientProvider>,
)
