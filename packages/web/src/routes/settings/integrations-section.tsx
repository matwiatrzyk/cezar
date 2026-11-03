import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { TelegramInboundStateResponse, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { ArrowLeftIcon, ChevronRightIcon, CircleDotIcon, LayoutGridIcon, SearchIcon, TicketIcon, WebhookIcon, HashIcon, MessagesSquareIcon, SendIcon } from 'lucide-react'
import { useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pill } from '@/components/pill'
import type { StatusDotTone } from '@/components/status-dot'
import { useE2eStatus, useHealth, useTrackerAssociation, useTrackerConnection } from '@/api/queries'
import { telegramApi } from '@/api/client'
import { useActiveProjectId } from '@/lib/project-router'
import testerArmyLogo from '@/assets/integrations/tester-army.png'
import { useWebhookList, webhookKey } from '@/hooks/use-webhooks'
import { telegramKey } from '@/hooks/use-telegram'
import { trackerProviders } from '@/lib/tracker-providers'
import { TelegramSettings, repliesDisabled } from './telegram-inbound'
import { TelegramWizard, telegramUnavailableMessages } from './telegram-wizard'
import { TesterArmyE2eCard } from './tester-army-e2e-card'
import { TrackerSection } from './tracker-section'
import { WebhooksSection } from './webhooks-section'

const telegramBadgeLabels: Record<string, string> = {
  polling: 'Connected',
  backoff: 'Retrying',
  stopped: 'Not running',
  blocked: 'Blocked',
  conflict: 'Conflict',
  'credentials-unavailable': 'No credentials',
}

type TelegramBadgeTone = 'connected' | 'attention' | 'none'
type TelegramGate = { available: boolean; reason?: string }
export type TelegramAvailability = { notifications: TelegramGate; taskControl: TelegramGate }

/** Notifications need CEZ_WEBHOOKS=1 only; task control also needs CEZ_CHAT_INBOUND=1 (spec 2026-10-29-telegram-setup-and-replies). */
export function telegramAvailability(state: TelegramInboundStateResponse | undefined, webhooks: boolean | undefined): TelegramAvailability {
  if (!state) {
    const off = webhooks === false ? { available: false, reason: 'webhooks_off' } : undefined
    return { notifications: off ?? { available: webhooks === true }, taskControl: off ?? { available: false, reason: 'unavailable' } }
  }
  const { notifications, taskControl } = state
  return { notifications, taskControl: notifications.available ? taskControl : { available: false, reason: taskControl.reason ?? notifications.reason } }
}

/**
 * The badge answers "is Telegram actually working for this project?", from the inbound state the
 * server owns — not from how many webhook receivers happen to be configured. A bot that is
 * polling reads as connected; a bot in a degraded health state (blocked, conflicted, retrying)
 * reads as the problem itself, so a broken integration never masquerades as a healthy one.
 */
function telegramBadge(state: TelegramInboundStateResponse | undefined, notificationChats: number, failed: boolean, taskControl: boolean, chats: readonly WebhookReceiver[] = []): { tone: TelegramBadgeTone; label: string } {
  if (failed) return { tone: 'attention', label: 'Unavailable' }
  const connected = state?.receivers.some(row => row.botId) ?? false
  // Without task control nothing polls, so delivery receivers are the only sign of a working setup.
  if (!connected && notificationChats > 0 && state?.available === false) return { tone: 'connected', label: 'Notifications only' }
  if (!connected) return { tone: 'none', label: 'Not set up' }
  const health: string[] = state?.bots.map(bot => bot.health.state) ?? []
  if (health.every(state => state === 'polling')) return { tone: 'connected', label: 'Connected' }
  const fatal = ['blocked', 'conflict', 'credentials-unavailable'].find(state => health.includes(state))
  // Without an approved person or task control the bot never polls; its chats still get notifications.
  if (!fatal && (!state?.grants.length || !taskControl)) return { tone: 'connected', label: 'Notifications only' }
  // Replies disabled on every chat stops the poller on purpose; a suspended chat is a fault and stays attention.
  if (!fatal && state && state.bots.every(bot => bot.health.state === 'polling' || repliesDisabled(state, bot.botId, chats)))
    return { tone: 'connected', label: health.includes('polling') ? 'Connected' : 'Notifications only' }
  const order = ['blocked', 'conflict', 'credentials-unavailable', 'backoff', 'stopped']
  const worst = order.find(state => health.includes(state)) ?? 'backoff'
  return { tone: 'attention', label: telegramBadgeLabels[worst] ?? 'Needs attention' }
}

/**
 * Settings → project → External integrations: third-party tools cezar can install and wire into
 * this project for you. One tab per kind of tool; each tool is a card that owns its own setup
 * (spec .ai/specs/2026-10-29-telegram-setup-and-replies.md).
 */
function TelegramIntegrationPanel() {
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const enabled = health.data?.capabilities.webhooks === true
  const list = useWebhookList(projectId, enabled)
  const client = useQueryClient()
  const [wizardOpen, setWizardOpen] = useState(false)
  const telegramReceivers = list.data?.receivers.filter(row => row.format === 'telegram.v1') ?? []
  const telegram = useQuery({ queryKey: telegramKey(projectId), queryFn: ({ signal }) => telegramApi.list(projectId, signal), retry: false })
  const availability = telegramAvailability(telegram.data, health.data ? enabled : undefined)
  const badge = telegramBadge(telegram.data, telegramReceivers.length, telegram.isError, availability.taskControl.available, telegramReceivers)
  const hasBot = (telegram.data?.receivers.some(row => row.botId) ?? false) || telegramReceivers.length > 0
  const offReason = health.data && !availability.notifications.available ? availability.notifications.reason ?? 'unavailable' : undefined
  const controlOff = telegram.data && availability.notifications.available && !availability.taskControl.available ? availability.taskControl.reason ?? 'unavailable' : undefined
  const badgeClass = badge.tone === 'connected'
    ? 'rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success'
    : badge.tone === 'attention'
      ? 'rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning'
      : 'rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'
  return (
          <section className="flex flex-col gap-4 rounded-lg border border-border bg-card p-4" data-slot="telegram-integration">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-sm font-semibold">Telegram</h2>
                  <span data-slot="telegram-badge" data-state={badge.tone} className={badgeClass}>
                    {badge.label}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">Connect a Telegram bot to send task notifications and optionally manage tasks from Telegram. One bot per project can serve several chats.</p>
              </div>
              <Button disabled={!availability.notifications.available || list.isPending || telegram.isPending} onClick={() => setWizardOpen(true)}>{hasBot ? 'Add a chat' : 'Connect Telegram'}</Button>
            </div>
            {health.isError && <p role="status" className="text-sm text-danger">Telegram settings are unavailable because server health could not be loaded.</p>}
            {!health.isError && offReason && <p role="status" className="text-sm text-muted-foreground" data-slot="telegram-unavailable">{telegramUnavailableMessages[offReason] ?? telegramUnavailableMessages.unavailable}</p>}
            {!health.isError && controlOff && <p className="text-sm text-muted-foreground" data-slot="telegram-task-control-off">Notifications work now. {telegramUnavailableMessages[controlOff] ?? telegramUnavailableMessages.unavailable}</p>}
            {list.error && <p role="alert" className="text-sm text-danger">Telegram settings could not be loaded. Refresh the page and try again.</p>}
            {availability.notifications.available && !list.isPending && !list.error && <TelegramSettings key={projectId} projectId={projectId} receivers={telegramReceivers} />}
            <TelegramWizard projectId={projectId} addingChat={hasBot} existingNames={list.data?.receivers.map(row => row.name) ?? []} taskControlUnavailable={controlOff} open={wizardOpen} onOpenChange={setWizardOpen} onComplete={() => { void client.invalidateQueries({ queryKey: webhookKey(projectId) }); void client.invalidateQueries({ queryKey: telegramKey(projectId) }) }} />
          </section>
  )
}

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

const notificationTools = [
  { id: 'webhooks', name: 'Webhooks', format: 'cezar.json.v1', description: 'Send signed task events to your own endpoints.', icon: WebhookIcon },
  { id: 'slack', name: 'Slack', format: 'slack.v1', description: 'Send task updates to your Slack channels.', icon: HashIcon },
  { id: 'discord', name: 'Discord', format: 'discord.v1', description: 'Send task updates to your Discord channels.', icon: MessagesSquareIcon },
  { id: 'telegram', name: 'Telegram', format: 'telegram.v1', description: 'Send task updates to your Telegram chats.', icon: SendIcon },
] as const

const plannedIssueTools = [
  { id: 'clickup', name: 'ClickUp', description: 'Bring ClickUp tasks into your coding workflow.', icon: LayoutGridIcon },
] as const

export function IntegrationsSection() {
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  const webhooksEnabled = health.data?.capabilities?.webhooks === true
  const webhooks = useWebhookList(projectId, webhooksEnabled)
  const [params, setParams] = useSearchParams()
  const selected = params.get('integration')
  const openIntegration = (id?: string) => {
    const next = new URLSearchParams(params)
    if (id) next.set('integration', id)
    else next.delete('integration')
    setParams(next)
  }
  const association = useTrackerAssociation()
  const connection = useTrackerConnection()
  const e2e = useE2eStatus()
  const telegram = useQuery({ queryKey: telegramKey(projectId), queryFn: ({ signal }) => telegramApi.list(projectId, signal), retry: false })
  const telegramReceivers = webhooks.data?.receivers.filter(row => row.format === 'telegram.v1') ?? []
  const telegramState = telegram.data
  const telegramAvailable = telegramAvailability(telegramState, health.data ? webhooksEnabled : undefined)
  const telegramBadgeValue = telegramBadge(telegramState, telegramReceivers.length, telegram.isError, telegramAvailable.taskControl.available, telegramReceivers)
  const trackerError = association.isError || connection.isError || Boolean(connection.data?.error)
  const trackerPending = association.isPending || connection.isPending
  const tools: Tool[] = trackerProviders.map(provider => {
    const connected = association.data?.association?.kind === provider.kind && (connection.data?.demo === true || association.data?.association?.connectionId === connection.data?.connection?.id)
    const status = trackerError ? 'Status unavailable' : trackerPending ? 'Loading…' : connected ? 'Connected' : association.data?.association?.kind === provider.kind ? 'Reconnect' : 'Not connected'
    return {
      id: provider.kind,
      name: provider.label,
      description: provider.kind === 'jira' ? 'Turn issues from your project into coding tasks.' : 'Bring your team’s issues into your coding workflow.',
      status,
      category: 'Issue tracking',
      tone: trackerError ? 'danger' : connected ? 'success' : association.data?.association?.kind === provider.kind ? 'pending' : 'neutral',
      detail: association.data?.association?.kind === provider.kind ? association.data.association.externalName : 'Issue tracking',
      icon: provider.kind === 'jira' ? <TicketIcon className="size-5" aria-hidden /> : <CircleDotIcon className="size-5" aria-hidden />,
      configuration: <TrackerSection />,
    }
  })
  for (const tool of plannedIssueTools) tools.push({ ...tool, status: 'Planned', category: 'Issue tracking', tone: 'neutral', detail: 'Issue tracking', icon: <tool.icon className="size-5" aria-hidden />, configuration: <PlannedIntegrationDetail name={tool.name} /> })
  tools.push({
    id: 'e2e', name: 'TesterArmy e2e', description: 'Verify your changes with browser end-to-end tests.',
    status: e2e.isError ? 'Status unavailable' : e2e.isPending ? 'Loading…' : e2e.data?.configFile && e2e.data.workflow ? 'Installed' : 'Not set up',
    category: 'Testing', tone: e2e.isError ? 'danger' : e2e.data?.configFile && e2e.data.workflow ? 'success' : 'neutral', detail: 'End-to-end testing',
    icon: <img src={testerArmyLogo} alt="" className="size-7 rounded-md" />, configuration: <div className="mx-auto w-full max-w-2xl p-4 md:p-6"><TesterArmyE2eCard /></div>,
  })
  for (const tool of notificationTools) {
    const rows = webhooks.data?.receivers.filter(row => row.format === tool.format) ?? []
    const active = rows.filter(row => row.state === 'active').length
    const status = tool.id === 'telegram' ? telegramBadgeValue.label : health.isError || webhooks.isError ? 'Status unavailable' : webhooksEnabled ? active ? `${active} active` : 'Not configured' : 'Off on this server'
    tools.push({ ...tool, icon: <tool.icon className="size-5" aria-hidden />, status, category: 'Notifications', tone: tool.id === 'telegram' ? (telegramBadgeValue.tone === 'connected' ? 'success' : telegramBadgeValue.tone === 'attention' ? 'danger' : 'neutral') : health.isError || webhooks.isError ? 'danger' : webhooksEnabled && active ? 'success' : 'neutral', detail: rows.length ? `${rows.length} receiver${rows.length === 1 ? '' : 's'} · Task notifications` : 'Task notifications', configuration: tool.id === 'telegram' ? <TelegramIntegrationPanel /> : <WebhooksSection format={tool.format} /> })
  }
  const activeTool = tools.find(tool => tool.id === selected)
  if (activeTool) return <div role="region" aria-label={activeTool.name} data-slot="integration-detail">
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 pt-4 md:px-6"><Button className="self-start" size="sm" variant="ghost" onClick={() => openIntegration()}><ArrowLeftIcon />All integrations</Button><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-semibold">{activeTool.name}</h2><Pill dot={activeTool.tone}>{activeTool.status}</Pill></div></div>
    {activeTool.configuration}
  </div>
  return <IntegrationsGalleryGrid tools={tools} onOpen={openIntegration} />
}

function IntegrationsGalleryGrid({ tools, onOpen }: { tools: Tool[]; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState('')
  const needle = query.trim().toLocaleLowerCase()
  const visible = needle ? tools.filter(tool => [tool.name, tool.description, tool.category, tool.status].some(value => value.toLocaleLowerCase().includes(needle))) : tools
  return <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 p-4 pb-[calc(90px+env(safe-area-inset-bottom))] md:p-6 md:pb-6" data-slot="integrations-settings">
    <div className="relative"><SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden /><Input aria-label="Search integrations" placeholder="Search integrations…" className="pl-9" value={query} onChange={event => setQuery(event.target.value)} /></div>
    {visible.length === 0 && <p role="status" className="text-[13px] text-muted-foreground">No integrations match “{query.trim()}”.</p>}
    {(['Issue tracking', 'Testing', 'Notifications'] as const).map(category => {
      const categoryTools = visible.filter(tool => tool.category === category)
      if (!categoryTools.length) return null
      const hint = category === 'Issue tracking' ? 'Connect the project or team whose issues you work on.' : category === 'Testing' ? 'Set up browser tests for this project.' : 'Send task updates to your channels or endpoints.'
      return <section key={category} className="flex flex-col gap-2"><div><h2 className="text-sm font-semibold text-foreground">{category}</h2><p className="text-[13px] text-muted-foreground">{hint}</p></div><div className="grid gap-3 sm:grid-cols-2">{categoryTools.map(tool => <button key={tool.id} type="button" aria-label={`Configure ${tool.name}`} onClick={() => onOpen(tool.id)} className="flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="flex items-center gap-2.5"><span className="flex size-7 shrink-0 items-center justify-center text-muted-foreground">{tool.icon}</span><span className="min-w-0 flex-1 text-sm font-semibold text-foreground">{tool.name}</span><ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden /></span><span className="text-[13px] text-muted-foreground">{tool.description}</span><span className="mt-auto flex flex-wrap items-center gap-2"><Pill dot={tool.tone}>{tool.status}</Pill>{tool.detail !== category && tool.detail !== 'Task notifications' && <span className="min-w-0 break-words text-xs text-muted-foreground">{tool.detail}</span>}</span></button>)}</div></section>
    })}
  </div>
}

function PlannedIntegrationDetail({ name }: { name: string }) {
  return <section className="mx-auto w-full max-w-2xl p-4 md:p-6"><div className="rounded-lg border border-dashed border-border bg-card p-4"><h3 className="text-sm font-semibold">{name} integration</h3><p className="mt-1 text-[13px] text-muted-foreground">This integration is included in the library as a planning placeholder. Configuration will be added in a future iteration.</p></div></section>
}
