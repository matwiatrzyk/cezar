import { ArrowLeftIcon, ChevronRightIcon, CircleDotIcon, TicketIcon, WebhookIcon, HashIcon, MessagesSquareIcon, SendIcon } from 'lucide-react'
import { useSearchParams, useLocation } from 'react-router'
import { useEffect, useRef, type ReactNode } from 'react'

import { useProjectScope } from '@/api/project-scope-context'
import { useHealth, useE2eStatus, useRun, useTrackerAssociation, useTrackerConnection } from '@/api/queries'
import testerArmyLogo from '@/assets/integrations/tester-army.png'
import { Button } from '@/components/ui/button'
import { Pill } from '@/components/pill'
import type { StatusDotTone } from '@/components/status-dot'
import { useWebhookList } from '@/hooks/use-webhooks'
import { Navigate, useActiveProjectId } from '@/lib/project-router'
import { trackerProviders } from '@/lib/tracker-providers'
import { SettingsField } from './settings-field'
import { E2E_SETUP_IN_FLIGHT, TesterArmyE2eCard } from './tester-army-e2e-card'
import { TrackerSection } from './tracker-section'
import { WebhooksSection } from './webhooks-section'

type Tool = {
  id: string
  name: string
  description: string
  status: string
  category: 'Issue tracking' | 'Testing' | 'Notifications'
  tone: StatusDotTone
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
  { id: 'webhooks', name: 'Webhooks', format: 'cezar.json.v1', description: 'Send signed task events to your own endpoints.', icon: WebhookIcon, planned: false },
  { id: 'slack', name: 'Slack', format: 'slack.v1', description: 'Send task updates to your Slack channels.', icon: HashIcon, planned: false },
  { id: 'discord', name: 'Discord', format: 'discord.v1', description: 'Send task updates to your Discord channels.', icon: MessagesSquareIcon, planned: false },
  { id: 'telegram', name: 'Telegram', format: undefined, description: 'Send task updates to your Telegram chats.', icon: SendIcon, planned: true },
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
  const selected = params.get('integration')
  const openIntegration = (id?: string) => {
    const next = new URLSearchParams(params)
    next.delete('endpoint'); next.delete('tab')
    if (id) next.set('integration', id)
    else next.delete('integration')
    setParams(next)
  }
  const previousSelection = useRef<string | null>(null)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (selected) detailHeading.current?.focus()
    else if (previousSelection.current) document.getElementById(`integration-${previousSelection.current}`)?.focus()
    previousSelection.current = selected
  }, [selected])
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
      category: 'Issue tracking',
      tone: trackerError ? 'danger' : connected ? 'success' : ownsScope || ownsCredentials ? 'pending' : 'neutral',
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
    category: 'Testing',
    tone: e2e.isError || setupFailed ? 'danger' : installed ? 'success' : settingUp || needsMerge ? 'pending' : 'neutral',
    detail: installed ? 'Testing · Workflow ready' : 'End-to-end testing',
    icon: <img src={testerArmyLogo} alt="" className="size-7 rounded-md" />,
    configuration: <div className="mx-auto w-full max-w-2xl p-4 md:p-6"><TesterArmyE2eCard /></div>,
  })

  for (const tool of notificationTools) {
    const rows = tool.format ? webhooks.data?.receivers.filter(row => row.format === tool.format) ?? [] : []
    const active = rows.filter(row => row.state === 'active').length
    const attention = (webhooks.data && webhooks.data.webhookHealth.status !== 'ready') || rows.some(row => ['suspended', 'disabled'].includes(row.state))
    const failed = health.isError || (webhooksEnabled && webhooks.isError)
    const loading = (!health.data && !health.isError) || (webhooksEnabled && webhooks.isPending)
    tools.push({
      ...tool, icon: <tool.icon className="size-5" aria-hidden />, configuration: tool.planned ? <PlannedIntegrationDetail name={tool.name} /> : <WebhooksSection format={tool.format!} />,
      status: tool.planned ? 'Planned' : failed ? 'Status unavailable' : loading ? 'Loading…' : health.data?.capabilities?.webhooksUnavailableReason === 'unsupported_platform' ? 'Unavailable on this server' : !webhooksEnabled ? 'Off on this server' : attention ? 'Needs attention' : active ? `${active} active` : rows.length ? 'Inactive or paused' : 'Not configured',
      category: 'Notifications',
      tone: tool.planned ? 'neutral' : failed || attention ? 'danger' : webhooksEnabled && active ? 'success' : rows.length ? 'pending' : 'neutral',
      detail: rows.length ? `${rows.length} receiver${rows.length === 1 ? '' : 's'} · Task notifications` : 'Task notifications',
    })
  }
  const activeTool = tools.find(tool => tool.id === selected)
  if (activeTool) return <div role="region" aria-label={activeTool.name} data-slot="integration-detail" key={`${projectId}:${activeTool.id}`}>
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-4 md:px-6 md:pt-6">
      <Button className="self-start" size="sm" variant="ghost" onClick={() => openIntegration()}><ArrowLeftIcon />All integrations</Button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 ref={detailHeading} tabIndex={-1} className="text-sm font-semibold outline-none">{activeTool.name}</h2>
        <Pill dot={activeTool.tone}>{activeTool.status}</Pill>
      </div>
    </div>
    {activeTool.configuration}
  </div>

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6" data-slot="integrations-settings">
      {([
        ['Issue tracking', 'Connect the project or team whose issues you work on.'],
        ['Testing', 'Set up browser tests for this project.'],
        ['Notifications', 'Send task updates to your channels or endpoints. You can add multiple receivers.'],
      ] as const).map(([category, hint]) => (
        <SettingsField key={category} title={category} hint={hint}>
          <div className="grid gap-3 sm:grid-cols-2">
            {tools.filter(tool => tool.category === category).map(tool => (
              <button key={tool.id} id={`integration-${tool.id}`} onClick={() => openIntegration(tool.id)} type="button" aria-label={`Configure ${tool.name}`} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <span className="flex items-center gap-2.5">
                  <span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">{tool.icon}</span>
                  <span className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tool.name}</span>
                  <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </span>
                <span className="text-[13px] text-muted-foreground">{tool.description}</span>
                <span className="mt-auto flex flex-wrap items-center gap-2">
                  <Pill dot={tool.tone}>{tool.status}</Pill>
                  {tool.detail !== category && tool.detail !== 'Task notifications' && <span className="min-w-0 break-words text-xs text-muted-foreground">{tool.detail}</span>}
                </span>
              </button>
            ))}
          </div>
        </SettingsField>
      ))}
      {(trackerError || e2e.isError || notificationError) && <div role="alert" className="flex flex-col items-start gap-2 text-[13px] text-danger">
        <p>Could not load some integration statuses. Your configuration has not changed.</p>
        <Button size="sm" variant="outline" onClick={() => {
          if (trackerError) { void association.refetch(); void connection.refetch() }
          if (e2e.isError) void e2e.refetch()
          if (health.isError) void health.refetch()
          if (webhooksEnabled && webhooks.isError) void webhooks.refetch()
        }}>Retry</Button>
      </div>}
    </div>
  )
}

function PlannedIntegrationDetail({ name }: { name: string }) {
  return <section className="mx-auto w-full max-w-2xl p-4 md:p-6">
    <div className="rounded-lg border border-dashed border-border bg-card p-4">
      <h3 className="text-sm font-semibold">{name} integration</h3>
      <p className="mt-1 text-[13px] text-muted-foreground">This integration is included in the library as a planning placeholder. Configuration will be added in a future iteration.</p>
    </div>
  </section>
}
