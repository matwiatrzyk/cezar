import { useProjects } from '@/api/queries'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { newTaskPrefillHref } from '@/routes/new-task-params'
import { FolderBrowser } from '@/components/folder-browser'
import { ExtensionFormView } from '@/components/extensions/form'
import { useState } from 'react'
import type { ExtensionManifest, ExtensionRecord, ExtensionTaskProposal, FsBrowseDir } from '@open-mercato/cezar-api-client'
import { useExtensionSubscription, prepareExtensionUpdate, loadExtensionForms, commitExtension, enableExtension, extensionKeys, listExtensions, loadExtensionPanel, prepareExtension, runExtensionCommand, uninstallExtension } from '@/api/extensions'
import { useProjectScope } from '@/api/project-scope-context'
import { ExtensionPanelView } from '@/components/extensions/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function PermissionPreview({ manifest }: { manifest: ExtensionManifest }) {
  const commands = [...manifest.actions, ...(manifest.contributes?.commands ?? [])]
  const panels = [...manifest.panels, ...(manifest.contributes?.panels ?? [])]
  return <>
    <p>{manifest.name} · {manifest.version}</p>
    <p>Capabilities: {manifest.capabilities?.join(', ') || 'Commands and panels'}</p>
    <p>Access: {manifest.permissions.join(', ') || 'No host permissions requested'}</p>
    <p>Contributions: {commands.length} commands, {panels.length} panels</p>
    <p className="text-sm text-muted-foreground">Only approve code you trust. Extensions run locally as your user. Worker isolation is not a security sandbox; permissions limit Cezar APIs, not filesystem or network access.</p>
  </>
}

function LivePanel({ projectId, extensionId, panelId, onProposals }: { projectId: string; extensionId: string; panelId: string; onProposals: (proposals: ExtensionTaskProposal[]) => void }) {
  const queryClient = useQueryClient()
  const panel = useQuery({ queryKey: extensionKeys.panel(projectId, extensionId, panelId), queryFn: () => loadExtensionPanel(projectId, extensionId, panelId) })
  if (panel.isPending) return <p>Loading panel…</p>
  if (panel.isError) return <div><p role="alert">{panel.error.message}</p><Button onClick={() => void panel.refetch()}>Retry panel</Button></div>
  return <ExtensionPanelView panel={panel.data} onAction={async id => {
    onProposals((await runExtensionCommand(projectId, extensionId, id)).proposals ?? [])
    await queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
  }} />
}

function LiveForms({ projectId, extensionId, onProposals }: { projectId: string; extensionId: string; onProposals: (proposals: ExtensionTaskProposal[]) => void }) {
  const forms = useQuery({ queryKey: [...extensionKeys.all(projectId), extensionId, 'forms'], queryFn: () => loadExtensionForms(projectId, extensionId) })
  if (forms.isError) return <div><p role="alert">{forms.error.message}</p><Button onClick={() => void forms.refetch()}>Retry forms</Button></div>
  return <>{forms.data?.forms.map(form => <ExtensionFormView key={form.id} form={form} submit={async input => { onProposals((await runExtensionCommand(projectId, extensionId, form.commandId, input)).proposals ?? []); await forms.refetch() }} />)}</>
}

export function ExtensionsSection() {
  const { projectId } = useProjectScope()
  return projectId ? <ProjectExtensions key={projectId} projectId={projectId} /> : <GlobalExtensions />
}

function GlobalExtensions() {
  const projects = useProjects()
  const [projectId, setProjectId] = useState('default')
  return <><label className="block p-4">Project access<select className="rounded-md border border-input bg-transparent px-3 py-2 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]" aria-label="Project access" value={projectId} onChange={event => setProjectId(event.target.value)}>
    <option value="default">Current project</option>
    {projects.data?.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
  </select></label><ProjectExtensions key={projectId} projectId={projectId} /></>
}

function ProjectExtensions({ projectId }: { projectId: string }) {
  useExtensionSubscription(projectId)
  const queryClient = useQueryClient()
  const [source, setSource] = useState('')
  const [proposals, setProposals] = useState<ExtensionTaskProposal[]>([])
  const [browse, setBrowse] = useState(false)
  const [folder, setFolder] = useState<FsBrowseDir | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ source: string; prepared: Awaited<ReturnType<typeof prepareExtension>> }>()
  const [enablePreview, setEnablePreview] = useState<ExtensionRecord>()
  const [removeData, setRemoveData] = useState(false)
  const [removeId, setRemoveId] = useState<string>()
  const refresh = () => queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
  const extensions = useQuery({ queryKey: extensionKeys.list(projectId), queryFn: () => listExtensions(projectId) })
  const prepare = useMutation({ mutationFn: (value: string) => prepareExtension(projectId, value), onSuccess: (prepared, value) => setPreview({ source: value, prepared }) })
  const update = useMutation({ mutationFn: ({ id }: { id: string; source: string }) => prepareExtensionUpdate(id), onSuccess: (prepared, value) => setPreview({ source: value.source, prepared }) })
  const install = useMutation({ mutationFn: (preparedId: string) => commitExtension(projectId, preparedId), onSuccess: async () => { setPreview(undefined); setSource(''); await refresh() } })
  const toggle = useMutation({ mutationFn: ({ id, enabled, integrity }: { id: string; enabled: boolean; integrity?: string }) => enableExtension(projectId, id, enabled, integrity), onSuccess: async () => { setEnablePreview(undefined); await refresh() } })
  const remove = useMutation({ mutationFn: (id: string) => uninstallExtension(projectId, id, removeData), onSuccess: async () => { setRemoveId(undefined); await refresh() } })
  const command = useMutation({ mutationFn: ({ id, commandId }: { id: string; commandId: string }) => runExtensionCommand(projectId, id, commandId), onSuccess: async result => { setProposals(result.proposals ?? []); await refresh() } })
  const busy = prepare.isPending || update.isPending || install.isPending || toggle.isPending || remove.isPending || command.isPending
  return <div data-slot="extensions-settings-section" className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6">
    <div><h2 className="text-sm font-semibold">Extensions</h2><p className="text-sm text-muted-foreground">Install a package or local folder globally, then approve access for project {projectId}. Installation does not enable an extension.</p></div>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (source.trim()) { setPreview(undefined); prepare.mutate(source.trim()) } }}>
      <Input aria-label="Extension folder or package" value={source} onChange={event => setSource(event.target.value)} placeholder="Package name or local folder path" />
      <Button type="submit" disabled={busy || !source.trim()}>Preview install</Button>
    </form>
    {[prepare, update, install, toggle, remove, command].map((mutation, index) => mutation.isError ? <p key={index} role="alert">{mutation.error.message}</p> : null)}
    <Button variant="outline" onClick={() => setBrowse(!browse)}>Choose local folder</Button>
    {browse && <><FolderBrowser path={path} selected={folder} onSelect={setFolder} onEnter={setPath} emptyHint="Choose a built extension folder." /><Button disabled={!folder} onClick={() => { if (folder) setSource(folder.path); setBrowse(false) }}>Use folder</Button></>}
    {proposals.map((proposal, index) => <section key={index} aria-label="Proposed task"><p>{proposal.title}</p><Link to={`/p/${encodeURIComponent(projectId)}${newTaskPrefillHref({ ref: proposal.prompt, workflow: proposal.workflow })}`}>Review task before starting</Link></section>)}
    {preview && <section aria-label="Installation preview" className="space-y-3 rounded border p-3">
      <PermissionPreview manifest={preview.prepared.manifest} />
      <p>Source: {preview.source}</p>
      <p>Added permissions: {preview.prepared.addedPermissions.join(', ') || 'None'}</p>
      <Button disabled={busy} onClick={() => install.mutate(preview.prepared.preparedId)}>Approve and install</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setPreview(undefined)}>Cancel install</Button>
    </section>}
    {enablePreview && <section aria-label="Project access approval" className="space-y-3 rounded border p-3">
      <PermissionPreview manifest={enablePreview.manifest} />
      <p>Enable for project {projectId}</p>
      <Button disabled={busy} onClick={() => toggle.mutate({ id: enablePreview.manifest.id, enabled: true, integrity: enablePreview.integrity })}>Approve and enable</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setEnablePreview(undefined)}>Cancel enable</Button>
    </section>}
    {removeId && <section aria-label="Uninstall extension" className="space-y-3 rounded border p-3">
      <p>Uninstall {removeId}? Configuration and extension data are preserved for reinstallation.</p>
      <label><input type="checkbox" checked={removeData} onChange={event => setRemoveData(event.target.checked)} />Delete this extension’s data and secrets from all registered projects</label>
      <Button disabled={busy} onClick={() => remove.mutate(removeId)}>{removeData ? 'Uninstall and delete data' : 'Uninstall and keep data'}</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setRemoveId(undefined)}>Cancel uninstall</Button>
    </section>}
    {extensions.isPending ? <p>Loading extensions…</p> : extensions.isError ? <div><p role="alert">{extensions.error.message}</p><Button onClick={() => void extensions.refetch()}>Retry</Button></div> : <ul className="flex flex-col gap-4">
      {extensions.data.extensions.length === 0 && <li>No extensions installed.</li>}
      {extensions.data.extensions.map(extension => <li aria-label={extension.manifest.name} key={extension.manifest.id} className="space-y-3 rounded border border-border p-3">
        <p>{extension.manifest.name} <small>{extension.manifest.version} · {extension.status ?? (extension.enabled ? 'Enabled' : 'Disabled')}</small></p>
        <p className="break-all text-sm text-muted-foreground">{extension.source}</p>{extension.error && <p role="alert">{extension.error}</p>}
        <div className="flex flex-wrap gap-2">
          {extension.status === 'failed' && <Button disabled={busy} onClick={() => setEnablePreview(extension)}>Review and retry</Button>}
          <Button disabled={busy} onClick={() => extension.enabled ? toggle.mutate({ id: extension.manifest.id, enabled: false }) : setEnablePreview(extension)}>{extension.enabled ? 'Disable' : 'Enable'}</Button>
          <Button disabled={busy} variant="outline" onClick={() => { setPreview(undefined); update.mutate({ id: extension.manifest.id, source: extension.source }) }}>Reload / update</Button>
          <Button disabled={busy} variant="ghost" onClick={() => setRemoveId(extension.manifest.id)}>Uninstall</Button>
        </div>
        {extension.enabled && <>
          {!!extension.manifest.contributes?.forms.length && <LiveForms projectId={projectId} extensionId={extension.manifest.id} onProposals={setProposals} />}
          {[...extension.manifest.actions, ...(extension.manifest.contributes?.commands ?? [])].map(action => <Button key={action.id} disabled={busy} variant="outline" onClick={() => command.mutate({ id: extension.manifest.id, commandId: action.id })}>{action.label}</Button>)}
          {[...extension.manifest.panels, ...(extension.manifest.contributes?.panels ?? [])].map(panel => <LivePanel onProposals={setProposals} key={panel.id} projectId={projectId} extensionId={extension.manifest.id} panelId={panel.id} />)}
        </>}
      </li>)}
    </ul>}
  </div>
}
