import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { ExtensionManifest } from '@open-mercato/cezar-api-client'
import { commitExtension, enableExtension, extensionKeys, listExtensions, loadExtensionPanel, prepareExtension, runExtensionCommand, uninstallExtension } from '@/api/extensions'
import { useProjectScope } from '@/api/project-scope-context'
import { ExtensionPanelView } from '@/components/extensions/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

function PermissionPreview({ manifest }: { manifest: ExtensionManifest }) {
  const commands = [...manifest.actions, ...(manifest.contributes?.commands ?? [])]
  const panels = [...manifest.panels, ...(manifest.contributes?.panels ?? [])]
  return <>
    <p>{manifest.name} · {manifest.version}</p>
    <p>Access: {manifest.permissions.join(', ') || 'No host permissions requested'}</p>
    <p>Contributions: {commands.length} commands, {panels.length} panels</p>
    <p className="text-sm text-muted-foreground">Only approve code you trust. Extensions run locally as your user. Worker isolation is not a security sandbox; permissions limit Cezar APIs, not filesystem or network access.</p>
  </>
}

function LivePanel({ projectId, extensionId, panelId }: { projectId: string; extensionId: string; panelId: string }) {
  const queryClient = useQueryClient()
  const panel = useQuery({ queryKey: extensionKeys.panel(projectId, extensionId, panelId), queryFn: () => loadExtensionPanel(projectId, extensionId, panelId) })
  if (panel.isPending) return <p>Loading panel…</p>
  if (panel.isError) return <div><p role="alert">{panel.error.message}</p><Button onClick={() => void panel.refetch()}>Retry panel</Button></div>
  return <ExtensionPanelView panel={panel.data} onAction={async id => {
    await runExtensionCommand(projectId, extensionId, id)
    await queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
  }} />
}

export function ExtensionsSection() {
  const { projectId } = useProjectScope()
  return <ProjectExtensions key={projectId ?? 'default'} projectId={projectId ?? 'default'} />
}

function ProjectExtensions({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient()
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<{ source: string; prepared: Awaited<ReturnType<typeof prepareExtension>> }>()
  const [enablePreview, setEnablePreview] = useState<ExtensionManifest>()
  const [removeId, setRemoveId] = useState<string>()
  const refresh = () => queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
  const extensions = useQuery({ queryKey: extensionKeys.list(projectId), queryFn: () => listExtensions(projectId) })
  const prepare = useMutation({ mutationFn: (value: string) => prepareExtension(projectId, value), onSuccess: (prepared, value) => setPreview({ source: value, prepared }) })
  const install = useMutation({ mutationFn: (preparedId: string) => commitExtension(projectId, preparedId), onSuccess: async () => { setPreview(undefined); setSource(''); await refresh() } })
  const toggle = useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => enableExtension(projectId, id, enabled), onSuccess: async () => { setEnablePreview(undefined); await refresh() } })
  const remove = useMutation({ mutationFn: (id: string) => uninstallExtension(projectId, id), onSuccess: async () => { setRemoveId(undefined); await refresh() } })
  const command = useMutation({ mutationFn: ({ id, commandId }: { id: string; commandId: string }) => runExtensionCommand(projectId, id, commandId), onSuccess: refresh })
  const busy = prepare.isPending || install.isPending || toggle.isPending || remove.isPending || command.isPending
  return <div data-slot="extensions-settings-section" className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6">
    <div><h2 className="text-sm font-semibold">Project extensions</h2><p className="text-sm text-muted-foreground">Install a package or local folder, then approve access for project {projectId}. Installation does not enable an extension.</p></div>
    <form className="flex gap-2" onSubmit={event => { event.preventDefault(); if (source.trim()) { setPreview(undefined); prepare.mutate(source.trim()) } }}>
      <Input aria-label="Extension folder or package" value={source} onChange={event => setSource(event.target.value)} placeholder="Package name or local folder path" />
      <Button type="submit" disabled={busy || !source.trim()}>Preview install</Button>
    </form>
    {[prepare, install, toggle, remove, command].map((mutation, index) => mutation.isError ? <p key={index} role="alert">{mutation.error.message}</p> : null)}
    {preview && <section aria-label="Installation preview" className="space-y-3 rounded border p-3">
      <PermissionPreview manifest={preview.prepared.manifest} />
      <p>Source: {preview.source}</p>
      <p>Added permissions: {preview.prepared.addedPermissions.join(', ') || 'None'}</p>
      <Button disabled={busy} onClick={() => install.mutate(preview.prepared.preparedId)}>Approve and install</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setPreview(undefined)}>Cancel install</Button>
    </section>}
    {enablePreview && <section aria-label="Project access approval" className="space-y-3 rounded border p-3">
      <PermissionPreview manifest={enablePreview} />
      <p>Enable for project {projectId}</p>
      <Button disabled={busy} onClick={() => toggle.mutate({ id: enablePreview.id, enabled: true })}>Approve and enable</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setEnablePreview(undefined)}>Cancel enable</Button>
    </section>}
    {removeId && <section aria-label="Uninstall extension" className="space-y-3 rounded border p-3">
      <p>Uninstall {removeId}? Configuration and extension data are preserved for reinstallation.</p>
      <Button disabled={busy} onClick={() => remove.mutate(removeId)}>Uninstall and keep data</Button>
      <Button variant="ghost" disabled={busy} onClick={() => setRemoveId(undefined)}>Cancel uninstall</Button>
    </section>}
    {extensions.isPending ? <p>Loading extensions…</p> : extensions.isError ? <div><p role="alert">{extensions.error.message}</p><Button onClick={() => void extensions.refetch()}>Retry</Button></div> : <ul className="flex flex-col gap-4">
      {extensions.data.extensions.length === 0 && <li>No extensions installed.</li>}
      {extensions.data.extensions.map(extension => <li key={extension.manifest.id} className="space-y-3 rounded border border-border p-3">
        <p>{extension.manifest.name} <small>{extension.manifest.version} · {extension.enabled ? 'Enabled' : 'Disabled'}</small></p>
        <p className="break-all text-sm text-muted-foreground">{extension.source}</p>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => extension.enabled ? toggle.mutate({ id: extension.manifest.id, enabled: false }) : setEnablePreview(extension.manifest)}>{extension.enabled ? 'Disable' : 'Enable'}</Button>
          <Button disabled={busy} variant="outline" onClick={() => { setPreview(undefined); prepare.mutate(extension.source) }}>Reload / update</Button>
          <Button disabled={busy} variant="ghost" onClick={() => setRemoveId(extension.manifest.id)}>Uninstall</Button>
        </div>
        {extension.enabled && <>
          {[...extension.manifest.actions, ...(extension.manifest.contributes?.commands ?? [])].map(action => <Button key={action.id} disabled={busy} variant="outline" onClick={() => command.mutate({ id: extension.manifest.id, commandId: action.id })}>{action.label}</Button>)}
          {[...extension.manifest.panels, ...(extension.manifest.contributes?.panels ?? [])].map(panel => <LivePanel key={panel.id} projectId={projectId} extensionId={extension.manifest.id} panelId={panel.id} />)}
        </>}
      </li>)}
    </ul>}
  </div>
}
