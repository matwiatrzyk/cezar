import { useHealth, useProjects } from '@/api/queries'
import { pathnameProjectId } from '@/lib/project-router'
import { settingsReturnLocation } from '@/lib/settings-return'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderBrowser } from '@/components/folder-browser'
import { ExtensionFormView } from '@/components/extensions/form'
import { useState } from 'react'
import type { ExtensionManifest, ExtensionRecord, FsBrowseDir } from '@open-mercato/cezar-api-client'
import { useExtensionSubscription, prepareExtensionUpdate, loadExtensionForms, commitExtension, enableExtension, extensionKeys, listExtensions, loadExtensionPanel, prepareExtension, runExtensionCommand, uninstallExtension } from '@/api/extensions'
import { useProjectScope } from '@/api/project-scope-context'
import { ExtensionPanelView } from '@/components/extensions/panel'
import { ExtensionCommandOutcome, useExtensionCommandResult, type ExtensionCommandOutcomeValue as CommandOutcomeValue } from '@/components/extensions/command-outcome'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/pill'
import type { StatusDotTone } from '@/components/status-dot'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'

/** Settings shows only Settings-located contributions; palette/sidebar/task ones render in their own
 *  surfaces (spec 2026-11-07-extension-placements-v1.1) and a task panel needs a runId anyway. */
const inSettings = (item: { location?: string }) => (item.location ?? 'settings') === 'settings'

function PermissionPreview({ manifest }: { manifest: ExtensionManifest }) {
  const commands = [...manifest.actions, ...(manifest.contributes?.commands ?? [])]
  const panels = [...manifest.panels, ...(manifest.contributes?.panels ?? [])]
  return <div className="flex flex-col gap-2 text-sm">
    <p>{manifest.name} · {manifest.version}</p>
    <p>Capabilities: {manifest.capabilities?.join(', ') || 'Commands and panels'}</p>
    <p>Access: {manifest.permissions.join(', ') || 'No host permissions requested'}</p>
    <p>Contributions: {commands.length} commands, {panels.length} panels</p>
    <p className="text-muted-foreground">Only approve code you trust. Extensions run locally as your user. Worker isolation is not a security sandbox; permissions limit Cezar APIs, not filesystem or network access.</p>
  </div>
}

function LivePanel({ projectId, extensionId, panelId, onOutcome }: { projectId: string; extensionId: string; panelId: string; onOutcome: (outcome: CommandOutcomeValue) => void }) {
  const queryClient = useQueryClient()
  const panel = useQuery({ queryKey: extensionKeys.panel(projectId, extensionId, panelId), queryFn: () => loadExtensionPanel(projectId, extensionId, panelId) })
  if (panel.isPending) return <p>Loading panel…</p>
  if (panel.isError) return <div><p role="alert" className="text-sm text-danger">{panel.error.message}</p><Button onClick={() => void panel.refetch()}>Retry panel</Button></div>
  return <ExtensionPanelView panel={panel.data} onAction={async id => {
    onOutcome(await runExtensionCommand(projectId, extensionId, id))
    await queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
  }} />
}

function LiveForms({ projectId, extensionId, onOutcome }: { projectId: string; extensionId: string; onOutcome: (outcome: CommandOutcomeValue) => void }) {
  const forms = useQuery({ queryKey: [...extensionKeys.all(projectId), extensionId, 'forms'], queryFn: () => loadExtensionForms(projectId, extensionId) })
  return <>
    {forms.isError && <div><p role="alert" className="text-sm text-danger">{forms.error.message}</p><Button onClick={() => void forms.refetch()}>Retry forms</Button></div>}
    {forms.data?.forms.map(form => <ExtensionFormView key={form.id} form={form} submit={async input => {
      onOutcome(await runExtensionCommand(projectId, extensionId, form.commandId, input))
      const refreshed = await forms.refetch()
      // A failed read may still carry cached data. It is not a canonical save result.
      if (!refreshed.isError) return refreshed.data?.forms.find(saved => saved.id === form.id)
    }} />)}
  </>
}

export function ExtensionsSection() {
  const { projectId } = useProjectScope()
  return projectId ? <ProjectExtensions key={projectId} projectId={projectId} /> : <GlobalExtensions />
}

/** A project's display name; `default` is the boot project's alias. */
function useProjectName(projectId: string): string {
  const projects = useProjects().data
  const id = projectId === 'default' ? projects?.bootProject : projectId
  return projects?.projects.find(project => project.id === id)?.name ?? (projectId === 'default' ? 'the current project' : projectId)
}

/** The registered project the user left to open settings, else the boot project (`default`). */
function useOriginProject(): string {
  const projects = useProjects().data
  const [origin] = useState(() => pathnameProjectId(settingsReturnLocation()?.pathname ?? ''))
  return origin && origin !== projects?.bootProject && projects?.projects.some(project => project.id === origin) ? origin : 'default'
}

function GlobalExtensions() {
  const projects = useProjects().data
  const origin = useOriginProject()
  const [chosen, setChosen] = useState<string>()
  const projectId = chosen ?? origin
  const boot = projects?.projects.find(project => project.id === projects.bootProject)
  const label = (id: string, name: string) => id === origin ? `${name} (current)` : name
  return <><label className="flex flex-col gap-1 p-4">Project access<select className={selectStyle} aria-label="Project access" value={projectId} onChange={event => setChosen(event.target.value)}>
    <option value="default">{boot ? label('default', boot.name) : 'Current project'}</option>
    {projects?.projects.filter(project => project.id !== projects.bootProject).map(project => <option key={project.id} value={project.id}>{label(project.id, project.name)}</option>)}
  </select></label><ProjectExtensions key={projectId} projectId={projectId} /></>
}

const selectStyle = 'h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
const statusPill: Record<NonNullable<ExtensionRecord['status']>, { label: string; tone: StatusDotTone; pulse?: boolean }> = {
  running: { label: 'Running', tone: 'success' },
  starting: { label: 'Starting', tone: 'pending', pulse: true },
  failed: { label: 'Failed', tone: 'danger' },
  disabled: { label: 'Disabled', tone: 'neutral' },
}
function StatusPill({ extension, off = false }: { extension: ExtensionRecord; off?: boolean }) {
  // With extensions off nothing runs, whatever the saved consent says.
  if (off) return <Pill dot="neutral"><span className="sr-only">Status: </span>{extension.enabled ? 'Enabled · not running' : 'Disabled'}</Pill>
  const status = statusPill[extension.status ?? (extension.enabled ? 'running' : 'disabled')]
  const label = extension.status ? status.label : extension.enabled ? 'Enabled' : 'Disabled'
  return <Pill dot={status.tone} pulse={status.pulse === true}><span className="sr-only">Status: </span>{label}</Pill>
}
type InstallPreview = Awaited<ReturnType<typeof prepareExtension>>
const projectCount = (count: number) => `${count} project${count === 1 ? '' : 's'}`
/** What approving this preview does to projects — true for a fresh install and a replacement (M2). */
function installEffect({ replaces }: InstallPreview): string {
  if (!replaces) return 'Installing does not enable it for any project.'
  const head = `Replaces version ${replaces.version}${replaces.sourceChanged ? ' from a different source' : ''}.`
  if (!replaces.enabledProjects) return `${head} It is not enabled in any project.`
  if (replaces.keepsConsent) return `${head} It stays enabled in ${projectCount(replaces.enabledProjects)} and restarts on this version.`
  return `${head} It will be disabled in ${projectCount(replaces.enabledProjects)} until you approve it again${replaces.sourceChanged ? '' : ', because it asks for more access'}.`
}
const offCopy: Record<'flag_off' | 'hosted', string> = {
  flag_off: 'CEZ_EXTENSIONS=0 turns them off. Restart cezar without it to install, enable or run extensions.',
  hosted: 'Extensions run only on a local cockpit. Install and run them on the machine that hosts cezar.',
}

const ErrorText = ({ error }: { error: Error | null }) => error ? <p role="alert" className="text-sm text-danger">{error.message}</p> : null

function ProjectExtensions({ projectId }: { projectId: string }) {
  useExtensionSubscription(projectId)
  const queryClient = useQueryClient()
  const projectName = useProjectName(projectId)
  const [source, setSource] = useState('')
  // One result slot for the whole list, shown in the row that produced it (finding 7).
  const { result, show, dismiss } = useExtensionCommandResult()
  const showResult = (extensionId: string) => (outcome: CommandOutcomeValue) => show(extensionId, outcome)
  const health = useHealth().data
  // An older server sends no flag: treat it as available, the routes still answer 409 if not.
  const off = health?.capabilities?.extensions === false ? health.capabilities.extensionsUnavailableReason ?? 'flag_off' : undefined
  const [browse, setBrowse] = useState(false)
  const [folder, setFolder] = useState<FsBrowseDir | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ source: string; prepared: InstallPreview }>()
  const [enablePreview, setEnablePreview] = useState<ExtensionRecord>()
  // The delete-data choice belongs to one uninstall target: it lives and dies with it.
  const [removal, setRemoval] = useState<{ extension: ExtensionRecord; removeData: boolean }>()
  const refresh = () => queryClient.invalidateQueries({ queryKey: extensionKeys.all(projectId) })
  const extensions = useQuery({ queryKey: extensionKeys.list(projectId), queryFn: () => listExtensions(projectId) })
  const prepare = useMutation({ mutationFn: (value: string) => prepareExtension(projectId, value), onSuccess: (prepared, value) => setPreview({ source: value, prepared }) })
  const update = useMutation({ mutationFn: ({ id }: { id: string; source: string }) => prepareExtensionUpdate(id), onSuccess: (prepared, value) => setPreview({ source: value.source, prepared }) })
  const install = useMutation({ mutationFn: (preparedId: string) => commitExtension(projectId, preparedId), onSuccess: async () => { setPreview(undefined); setSource(''); await refresh() } })
  const toggle = useMutation({ mutationFn: ({ id, enabled, integrity }: { id: string; enabled: boolean; integrity?: string }) => enableExtension(projectId, id, enabled, integrity), onSuccess: async () => { setEnablePreview(undefined); await refresh() } })
  const remove = useMutation({ mutationFn: ({ id, removeData }: { id: string; removeData: boolean }) => uninstallExtension(projectId, id, removeData), onSuccess: async () => { setRemoval(undefined); await refresh() } })
  const command = useMutation({ mutationFn: ({ id, commandId }: { id: string; commandId: string }) => runExtensionCommand(projectId, id, commandId), onSuccess: async (outcome, { id }) => { showResult(id)(outcome); await refresh() } })
  const mutations = [prepare, update, install, toggle, remove, command]
  const busy = mutations.some(mutation => mutation.isPending)
  /** Clears every earlier failure, so an error on screen always belongs to the latest operation. */
  const fresh = () => { for (const mutation of mutations) mutation.reset(); dismiss() }
  const rowError = (id: string) => update.variables?.id === id ? update.error : toggle.variables?.id === id && !enablePreview ? toggle.error : command.variables?.id === id ? command.error : null
  return <div data-slot="extensions-settings-section" className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-6">
    <div><h2 className="text-sm font-semibold">Extensions</h2><p className="text-sm text-muted-foreground">Install a package or local folder globally, then approve access for {projectName}. Installation does not enable an extension.</p></div>
    {off && <div role="note" data-slot="extensions-off" className="rounded-md border border-border bg-muted/50 p-3 text-sm"><p className="font-medium">Extensions are off on this server</p><p className="text-muted-foreground">{offCopy[off]} Installed extensions are listed below; you can disable them, but nothing runs.</p></div>}
    {!off && <><form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (source.trim()) { fresh(); setPreview(undefined); prepare.mutate(source.trim()) } }}>
      <div className="flex gap-2">
        <Input aria-label="Extension folder or package" value={source} onChange={event => setSource(event.target.value)} placeholder="Package name or local folder path" />
        <Button type="submit" disabled={busy || !source.trim()}>Preview install</Button>
      </div>
      <ErrorText error={prepare.error} />
    </form>
    <Button variant="outline" onClick={() => setBrowse(!browse)}>Choose local folder</Button>
    {browse && <><FolderBrowser path={path} selected={folder} onSelect={setFolder} onEnter={setPath} emptyHint="Choose a built extension folder." /><Button disabled={!folder} onClick={() => { if (folder) setSource(folder.path); setBrowse(false) }}>Use folder</Button></>}</>}
    <Dialog open={!!preview} onOpenChange={open => { if (!open && !busy) { install.reset(); setPreview(undefined) } }}>
      <DialogContent>{preview && <>
        <DialogHeader><DialogTitle>Install {preview.prepared.manifest.name}?</DialogTitle>
          <DialogDescription>Review what this extension can do before installing it. {installEffect(preview.prepared)}</DialogDescription></DialogHeader>
        <PermissionPreview manifest={preview.prepared.manifest} />
        <p className="text-sm [overflow-wrap:anywhere]">Source: {preview.source}</p>
        <p className="text-sm">Added permissions: {preview.prepared.addedPermissions.join(', ') || 'None'}</p>
        <p className="text-sm">Added capabilities: {preview.prepared.addedCapabilities.join(', ') || 'None'}</p>
        <ErrorText error={install.error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { install.reset(); setPreview(undefined) }}>Cancel install</Button>
          <Button disabled={busy} onClick={() => { fresh(); install.mutate(preview.prepared.preparedId) }}>Approve and install</Button>
        </DialogFooter>
      </>}</DialogContent>
    </Dialog>
    <Dialog open={!!enablePreview} onOpenChange={open => { if (!open && !busy) { toggle.reset(); setEnablePreview(undefined) } }}>
      <DialogContent>{enablePreview && <>
        <DialogHeader><DialogTitle>Enable {enablePreview.manifest.name} for {projectName}?</DialogTitle>
          <DialogDescription>The extension starts and can use the access below in this project.</DialogDescription></DialogHeader>
        <PermissionPreview manifest={enablePreview.manifest} />
        <ErrorText error={toggle.error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => { toggle.reset(); setEnablePreview(undefined) }}>Cancel enable</Button>
          <Button disabled={busy} onClick={() => { fresh(); toggle.mutate({ id: enablePreview.manifest.id, enabled: true, integrity: enablePreview.integrity }) }}>Approve and enable</Button>
        </DialogFooter>
      </>}</DialogContent>
    </Dialog>
    <AlertDialog open={!!removal} onOpenChange={open => { if (!open && !busy) { remove.reset(); setRemoval(undefined) } }}>
      <AlertDialogContent>{removal && <>
        <AlertDialogHeader><AlertDialogTitle>Uninstall {removal.extension.manifest.name}?</AlertDialogTitle>
          <AlertDialogDescription>Configuration and extension data are preserved for reinstallation.</AlertDialogDescription></AlertDialogHeader>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={removal.removeData} onChange={event => setRemoval({ ...removal, removeData: event.target.checked })} />Delete this extension’s data and secrets from all registered projects</label>
        <ErrorText error={remove.error} />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button className="bg-danger text-danger-foreground hover:brightness-[0.96]" disabled={busy} onClick={() => { fresh(); remove.mutate({ id: removal.extension.manifest.id, removeData: removal.removeData }) }}>{removal.removeData ? 'Uninstall and delete data' : 'Uninstall and keep data'}</Button>
        </AlertDialogFooter>
      </>}</AlertDialogContent>
    </AlertDialog>
    {extensions.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading extensions…</p> : extensions.isError ? <div><ErrorText error={extensions.error} /><Button onClick={() => void extensions.refetch()}>Retry</Button></div> : <ul className="flex flex-col gap-4">
      {extensions.data.extensions.length === 0 && <li className="rounded-md border border-dashed border-border p-4 text-sm"><p className="font-medium">No extensions installed</p><p className="text-muted-foreground">An extension is an npm package or a built local folder made with the Cezar extension SDK (@open-mercato/cezar-extension-sdk). {off ? 'Install one once extensions are on.' : 'Enter its package name or folder path above to preview what it can do.'}</p></li>}
      {extensions.data.extensions.map(extension => <li aria-label={extension.manifest.name} key={extension.manifest.id} className="space-y-3 rounded border border-border p-3">
        <div className="flex flex-wrap items-center gap-2"><strong>{extension.manifest.name}</strong><small className="text-muted-foreground">{extension.manifest.version}</small><StatusPill extension={extension} off={!!off} /></div>
        <p className="break-all text-sm text-muted-foreground">{extension.source}</p>{extension.error && <p role="alert" className="text-sm text-danger">{extension.error}</p>}
        {off ? <div className="flex flex-wrap gap-2">{extension.enabled && <Button disabled={busy} onClick={() => { fresh(); toggle.mutate({ id: extension.manifest.id, enabled: false }) }}>Disable</Button>}</div> : <div className="flex flex-wrap gap-2">
          {extension.status === 'failed' && <Button disabled={busy} onClick={() => { fresh(); setEnablePreview(extension) }}>Review and retry</Button>}
          <Button disabled={busy} onClick={() => { fresh(); if (extension.enabled) toggle.mutate({ id: extension.manifest.id, enabled: false }); else setEnablePreview(extension) }}>{extension.enabled ? 'Disable' : 'Enable'}</Button>
          <Button disabled={busy} variant="outline" onClick={() => { fresh(); setPreview(undefined); update.mutate({ id: extension.manifest.id, source: extension.source }) }}>Reload / update</Button>
          <Button disabled={busy} variant="danger-ghost" onClick={() => { fresh(); setRemoval({ extension, removeData: false }) }}>Uninstall</Button>
        </div>}
        <ErrorText error={rowError(extension.manifest.id)} />
        {/* A failed or starting worker cannot answer; its row offers Review and retry instead (M3). */}
        {!off && extension.enabled && (extension.status ?? 'running') === 'running' && <>
          {!!extension.manifest.contributes?.forms.length && <LiveForms projectId={projectId} extensionId={extension.manifest.id} onOutcome={showResult(extension.manifest.id)} />}
          {[...extension.manifest.actions, ...(extension.manifest.contributes?.commands ?? [])].filter(inSettings).map(action => <Button key={action.id} disabled={busy} variant="outline" onClick={() => { fresh(); command.mutate({ id: extension.manifest.id, commandId: action.id }) }}>{action.label}</Button>)}
          {[...extension.manifest.panels, ...(extension.manifest.contributes?.panels ?? [])].filter(inSettings).map(panel => <LivePanel onOutcome={showResult(extension.manifest.id)} key={panel.id} projectId={projectId} extensionId={extension.manifest.id} panelId={panel.id} />)}
        </>}
        <ExtensionCommandOutcome projectId={projectId} result={result?.extensionId === extension.manifest.id ? result : undefined} onDismiss={dismiss} />
      </li>)}
    </ul>}
  </div>
}
