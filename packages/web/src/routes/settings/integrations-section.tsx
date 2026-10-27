import { ArrowLeftIcon, ArrowRightIcon, CircleDotIcon, TicketIcon, WebhookIcon, HashIcon, MessagesSquareIcon } from 'lucide-react'
import { useSearchParams, useLocation } from 'react-router'
import { useRef, useState, type ReactNode } from 'react'

import { useProjectScope } from '@/api/project-scope-context'
import { useHealth, useE2eStatus, useRun, useTrackerAssociation, useTrackerConnection } from '@/api/queries'
import testerArmyLogo from '@/assets/integrations/tester-army.png'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useWebhookList } from '@/hooks/use-webhooks'
import { Navigate, useActiveProjectId } from '@/lib/project-router'
import { trackerProviders } from '@/lib/tracker-providers'
import { cn } from '@/lib/utils'
import { E2E_SETUP_IN_FLIGHT, TesterArmyE2eCard } from './tester-army-e2e-card'
import { TrackerSection } from './tracker-section'
import { WebhooksSection } from './webhooks-section'

type Tool = {
  id: string
  name: string
  description: string
  status: string
  group: 'In use' | 'Available' | 'Check status'
  detail: string
  icon: ReactNode
  configuration: ReactNode
}

export function IntegrationsSection() {
  const { projectId } = useProjectScope()
  // A project switch must discard open forms and their unsaved credentials.
  return <IntegrationsGallery key={projectId} />
}

const notificationTools = [
  { id: 'webhooks', name: 'Webhooks', format: 'cezar.json.v1', description: 'Send signed task events to your own endpoints.', icon: WebhookIcon },
  { id: 'slack', name: 'Slack', format: 'slack.v1', description: 'Send task updates to your Slack channels.', icon: HashIcon },
  { id: 'discord', name: 'Discord', format: 'discord.v1', description: 'Send task updates to your Discord channels.', icon: MessagesSquareIcon },
] as const

/** Preserve bookmarks and receiver/history links from the former settings section. */
export function LegacyWebhooksRedirect() {
  const location = useLocation()
  const search = new URLSearchParams(location.search)
  search.set('integration', 'webhooks')
  return <Navigate replace to={{ pathname: '/settings/integrations', search: `?${search}`, hash: location.hash }} />
}

function IntegrationsGallery() {
  const [params, setParams] = useSearchParams()
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const webhooksEnabled = !health.isError && health.data?.capabilities?.webhooks === true
  const webhooks = useWebhookList(projectId, webhooksEnabled)
  const notificationError = health.isError || (webhooksEnabled && webhooks.isError)
  const notificationTool = notificationTools.find(tool => tool.id === params.get('integration'))
  const openNotification = (id?: string) => {
    const next = new URLSearchParams(params)
    next.delete('endpoint'); next.delete('tab')
    if (id) next.set('integration', id)
    else next.delete('integration')
    setParams(next)
  }
  const [selected, setSelected] = useState<string | null>(null)
  const lastSelected = useRef<string | null>(null)
  const association = useTrackerAssociation()
  const connection = useTrackerConnection()
  const e2e = useE2eStatus()
  const setupRun = useRun(e2e.data?.setup?.runId)
  const saved = association.data?.association
  const credentials = connection.data?.connection
  const trackerError = association.isError || connection.isError || Boolean(connection.data?.error)
  const trackerPending = association.isPending || connection.isPending
  const tools: Tool[] = trackerProviders.map(provider => {
    const ownsScope = saved?.kind === provider.kind
    const ownsCredentials = credentials?.kind === provider.kind
    const connected = ownsScope && (connection.data?.demo === true || (ownsCredentials && saved.connectionId === credentials.id))
    const status = trackerError ? 'Status unavailable' : trackerPending ? 'Loading…' : connected ? 'Connected' : ownsScope ? 'Reconnect' : ownsCredentials ? 'Choose a project or team' : 'Not connected'
    return {
      id: provider.kind,
      name: provider.label,
      description: provider.kind === 'jira' ? 'Turn issues from your project into coding tasks.' : 'Bring your team’s issues into your coding workflow.',
      status,
      group: trackerError || trackerPending ? 'Check status' : ownsScope || ownsCredentials ? 'In use' : 'Available',
      detail: ownsScope ? saved.externalName : 'Issue tracking',
      icon: provider.kind === 'jira' ? <TicketIcon className="size-5" aria-hidden /> : <CircleDotIcon className="size-5" aria-hidden />,
      configuration: <TrackerSection providerKind={provider.kind} />,
    }
  })
  const setupStatus = setupRun.data?.status ?? e2e.data?.setup?.status
  const settingUp = setupStatus !== undefined && E2E_SETUP_IN_FLIGHT.has(setupStatus)
  const installed = Boolean(e2e.data?.configFile && e2e.data.workflow)
  const needsMerge = !installed && (setupStatus === 'review' || setupStatus === 'done')
  const setupFailed = setupStatus === 'failed' || setupStatus === 'cancelled'
  tools.push({
    id: 'e2e', name: 'TesterArmy e2e',
    description: 'Verify your changes with browser end-to-end tests.',
    status: e2e.isError ? 'Status unavailable' : e2e.isPending ? 'Loading…' : settingUp ? 'Setting up' : needsMerge ? 'Awaiting merge' : installed ? 'Installed' : setupFailed ? 'Setup incomplete' : 'Not set up',
    group: e2e.isError || e2e.isPending ? 'Check status' : installed || Boolean(e2e.data?.setup) || Boolean(e2e.data?.configFile) ? 'In use' : 'Available',
    detail: installed ? 'Testing · Workflow ready' : 'End-to-end testing',
    icon: <img src={testerArmyLogo} alt="" className="size-10 rounded-md" />,
    configuration: <div className="p-4 md:p-6"><TesterArmyE2eCard /></div>,
  })

  for (const tool of notificationTools) {
    const rows = webhooks.data?.receivers.filter(row => row.format === tool.format) ?? []
    const active = rows.filter(row => row.state === 'active').length
    const attention = (webhooks.data && webhooks.data.webhookHealth.status !== 'ready') || rows.some(row => ['suspended', 'disabled'].includes(row.state))
    const failed = health.isError || (webhooksEnabled && webhooks.isError)
    const loading = (!health.data && !health.isError) || (webhooksEnabled && webhooks.isPending)
    tools.push({
      ...tool, icon: <tool.icon className="size-5" aria-hidden />, configuration: null,
      status: failed ? 'Status unavailable' : loading ? 'Loading…' : health.data?.capabilities?.webhooksUnavailableReason === 'unsupported_platform' ? 'Unavailable on this server' : !webhooksEnabled ? 'Off on this server' : attention ? 'Needs attention' : active ? `${active} active` : rows.length ? 'Inactive or paused' : 'Not configured',
      group: failed || loading ? 'Check status' : rows.length ? 'In use' : 'Available',
      detail: rows.length ? `${rows.length} receiver${rows.length === 1 ? '' : 's'} · Task notifications` : 'Task notifications',
    })
  }
  // Notification management owns its dialogs and URL-backed history. Give it a full
  // page instead of nesting those dialogs inside the gallery's configuration sheet.
  if (notificationTool) return <div>
    <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 pt-4 md:px-6">
      <Button variant="ghost" onClick={() => openNotification()}><ArrowLeftIcon />All integrations</Button>
      <h2 className="text-base font-semibold">{notificationTool.name}</h2>
    </div>
    <WebhooksSection key={`${projectId}:${notificationTool.id}`} format={notificationTool.format} />
  </div>

  const activeTool = tools.find(tool => tool.id === selected)
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 pb-[calc(24px+env(safe-area-inset-bottom))] md:p-6" data-slot="integrations-settings">
      <p className="max-w-2xl text-sm text-muted-foreground">Connect issue trackers, test tools and task notifications in one place. Each tool is configured for this project.</p>
      {(['In use', 'Available', 'Check status'] as const).map(group => {
        const entries = tools.filter(tool => tool.group === group)
        if (entries.length === 0) return null
        return <section key={group} aria-label={group} className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">{group}<span className="rounded border border-border px-1.5 text-xs font-normal text-muted-foreground">{entries.length}</span></h2>
          <div className="grid gap-4 md:grid-cols-2">
            {entries.map(tool => <button key={tool.id} id={`integration-${tool.id}`} onClick={() => { lastSelected.current = tool.id; if (notificationTools.some(item => item.id === tool.id)) openNotification(tool.id); else setSelected(tool.id) }} type="button" aria-label={`Configure ${tool.name}`} className="flex min-h-52 flex-col rounded-lg border border-border bg-card p-5 text-left transition-colors hover:bg-card-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="flex w-full items-center justify-between gap-3"><span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-foreground">{tool.icon}</span><span className={cn('rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground', (tool.status === 'Connected' || tool.status === 'Installed') && 'bg-success/10 text-success')}>{tool.status}</span></span>
                  <span className="mt-4 text-base font-semibold">{tool.name}</span>
                  <span className="mt-1 text-sm text-muted-foreground">{tool.description}</span>
                  <span className="mt-auto flex w-full items-center justify-between gap-3 pt-5 text-xs"><span className="min-w-0 break-words text-muted-foreground">{tool.detail}</span><span className="flex shrink-0 items-center gap-2">Configure<ArrowRightIcon className="size-3.5" aria-hidden /></span></span>
                </button>)}
          </div>
        </section>
      })}
      <Sheet open={activeTool !== undefined} onOpenChange={open => { if (!open) setSelected(null) }}>
        <SheetContent className="w-full gap-0 overflow-y-auto pb-[env(safe-area-inset-bottom)] sm:max-w-xl" onCloseAutoFocus={event => {
          event.preventDefault()
          document.getElementById(`integration-${lastSelected.current}`)?.focus()
        }}>
          <SheetHeader className="border-b border-border p-4 md:p-6"><SheetTitle>{activeTool?.name}</SheetTitle><SheetDescription>Configuration for this project</SheetDescription></SheetHeader>
          {activeTool?.configuration}
        </SheetContent>
      </Sheet>
      {(trackerError || e2e.isError || notificationError) && <div role="alert" className="text-sm text-danger">Could not load some integration statuses. Your configuration has not changed. <Button variant="outline" onClick={() => { if (trackerError) { void association.refetch(); void connection.refetch() } if (e2e.isError) void e2e.refetch(); if (health.isError) void health.refetch(); if (webhooksEnabled && webhooks.isError) void webhooks.refetch() }}>Retry</Button></div>}
      <p className="border-t border-border pt-4 text-xs text-muted-foreground">Configure each tool independently. Add multiple notification receivers, including several channels in the same service.</p>
    </div>
  )
}
