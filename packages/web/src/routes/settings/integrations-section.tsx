import { ArrowRightIcon, CircleDotIcon, TicketIcon } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'

import { useProjectScope } from '@/api/project-scope-context'
import { useE2eStatus, useRun, useTrackerAssociation, useTrackerConnection } from '@/api/queries'
import testerArmyLogo from '@/assets/integrations/tester-army.png'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { trackerProviders } from '@/lib/tracker-providers'
import { cn } from '@/lib/utils'
import { E2E_SETUP_IN_FLIGHT, TesterArmyE2eCard } from './tester-army-e2e-card'
import { TrackerSection } from './tracker-section'

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

function IntegrationsGallery() {
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

  const activeTool = tools.find(tool => tool.id === selected)
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8 p-4 pb-[calc(24px+env(safe-area-inset-bottom))] md:p-6" data-slot="integrations-settings">
      <p className="max-w-2xl text-sm text-muted-foreground">Connect your issue tracker and set up end-to-end testing in one place. Each tool is configured for this project.</p>
      {(['In use', 'Available', 'Check status'] as const).map(group => {
        const entries = tools.filter(tool => tool.group === group)
        if (entries.length === 0) return null
        return <section key={group} aria-label={group} className="space-y-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">{group}<span className="rounded border border-border px-1.5 text-xs font-normal text-muted-foreground">{entries.length}</span></h2>
          <div className="grid gap-4 md:grid-cols-2">
            {entries.map(tool => <button key={tool.id} id={`integration-${tool.id}`} onClick={() => { lastSelected.current = tool.id; setSelected(tool.id) }} type="button" aria-label={`Configure ${tool.name}`} className="flex min-h-52 flex-col rounded-lg border border-border bg-card p-5 text-left transition-colors hover:bg-card-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
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
      {(trackerError || e2e.isError) && <div role="alert" className="text-sm text-danger">Could not load some integration statuses. Your configuration has not changed. <Button variant="outline" onClick={() => { if (trackerError) { void association.refetch(); void connection.refetch() } if (e2e.isError) void e2e.refetch() }}>Retry</Button></div>}
      <p className="border-t border-border pt-4 text-xs text-muted-foreground">Your issue tracker and test tools work alongside each other. Configure each tool independently.</p>
    </div>
  )
}
