import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { WebhookReceiver, WebhookHistoricalReceiver, WebhookDelivery } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { webhookKey } from '@/hooks/use-webhooks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { webhookTime, webhookTimeZone } from './webhook-presentation'
import { Link } from '@/lib/project-router'
import { eventLabels } from './webhook-form'
export function ReceiverHistory({ projectId, receiver, operation, tab: selectedTab, onTabChange }: { tab?: 'deliveries' | 'activity'; onTabChange?: (tab: 'deliveries' | 'activity') => void; projectId: string; receiver: WebhookReceiver | WebhookHistoricalReceiver; operation: (action: 'retry' | 'replay', row: WebhookDelivery, receiver: WebhookReceiver) => void }) {
  const [localTab, setLocalTab] = useState<'deliveries' | 'activity'>('deliveries')
  const tab = selectedTab ?? localTab
  const setTab = (value: typeof tab) => { setLocalTab(value); onTabChange?.(value) }
  const [filter, setFilter] = useState('all')
  const [taskId, setTaskId] = useState('')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string>()
  const deliveries = useInfiniteQuery({ queryKey: [...webhookKey(projectId), receiver.id, 'deliveries', taskId], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => webhookApi.deliveries(projectId, receiver.id, pageParam, taskId || undefined), getNextPageParam: page => page.nextCursor, enabled: tab === 'deliveries', retry: false })
  const activity = useQuery({ queryKey: [...webhookKey(projectId), receiver.id, 'activity'], queryFn: () => webhookApi.activity(projectId, receiver.id), enabled: tab === 'activity', retry: false })
  const rows = [...new Map((deliveries.data?.pages.flatMap(page => page.items) ?? []).map(row => [row.deliveryId, row])).values()]
  const visible = rows.filter(row => filter === 'all' || row.status === filter)
  return <section className="min-w-0 space-y-3">
    {receiver.kind === 'history' && <p className="rounded-md border p-3 text-sm">Deleted receiver — read-only history. Configuration and signing keys are no longer available. Deleted {webhookTime(receiver.deletedAt)}. History is retained for up to 30 days, subject to storage limits.</p>}
    <Tabs value={tab} onValueChange={value => setTab(value as typeof tab)}>
    <TabsList aria-label="Receiver history"><TabsTrigger value="deliveries">Deliveries</TabsTrigger><TabsTrigger value="activity">Activity</TabsTrigger></TabsList>
    <TabsContent value="activity" className="space-y-2">
      <p className="text-sm text-soft-foreground">Times shown in {webhookTimeZone(activity.data?.timezone).label}.</p>
      {activity.isPending && <p>Loading activity…</p>}{activity.error && <p role="alert">{activity.error.message}</p>}
      {activity.data?.items.map(row => <div key={row.id} className="rounded border p-3 text-sm"><time>{webhookTime(row.at, activity.data?.timezone)}</time> · {row.action.replaceAll('_', ' ')} · {row.source}{row.revision !== undefined && <span> · Revision {row.revision}</span>}{row.fields.length > 0 && <p>Changed fields: {row.fields.join(', ')}</p>}{row.detail && <p>{row.detail}</p>}</div>)}
      {activity.data?.items.length === 0 && <p>No retained activity.</p>}{activity.data?.hasMore && <p className="text-sm">Showing the latest 100 actions.</p>}
    </TabsContent><TabsContent value="deliveries" className="space-y-3">
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setTaskId(search.trim()) }}><label className="flex-1 text-sm">Task ID (optional)<Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find retained deliveries for a task" /></label><Button type="submit" variant="outline">Find task</Button></form>
      <label className="block text-sm">Result filter <select className="ml-2 rounded border bg-background p-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={filter} onChange={event => setFilter(event.target.value)}>{['all', 'pending', 'in_flight', 'retrying', 'blocked_policy', 'delivered', 'failed', 'superseded', 'cancelled', 'dropped'].map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
      <p className="text-sm text-soft-foreground">Showing {rows.length ? `1–${rows.length}` : '0'} of {deliveries.data?.pages[0]?.total ?? 0} retained records. Result filters apply to loaded entries. Times shown in {webhookTimeZone(deliveries.data?.pages[0]?.timezone).label}.</p>
      {deliveries.isPending && <p>Loading deliveries…</p>}{deliveries.error && <p role="alert">{deliveries.error.message}</p>}
      {!deliveries.isPending && visible.length === 0 && <p>No matching retained deliveries.</p>}
      {visible.map(row => <article key={row.deliveryId} className="min-w-0 rounded-md border p-3 text-sm">
        <button className="w-full text-left" type="button" aria-expanded={expanded === row.deliveryId} onClick={() => setExpanded(current => current === row.deliveryId ? undefined : row.deliveryId)}><span className="font-medium">{eventLabels[row.eventType]}</span> · {row.status.replaceAll('_', ' ')}<span className="block text-soft-foreground">{webhookTime(row.createdAt, deliveries.data?.pages[0]?.timezone)} · {row.attempts} attempt{row.attempts === 1 ? '' : 's'}</span></button>
        {expanded === row.deliveryId && <div className="mt-3 space-y-2 break-words"><p>Destination: {row.destination}</p><p>Event: {row.eventId}</p><p>Delivery: {row.deliveryId}</p>{row.taskId && <p>Task: {row.taskAvailability === 'available' ? <Link className="underline" to={`/tasks/${encodeURIComponent(row.taskId)}`}>{row.taskId}</Link> : row.taskId}</p>}{row.taskAvailability === 'deleted' && <p>Task deleted. Retained event history remains available.</p>}{row.taskAvailability === 'unknown' && <p>Current task availability could not be verified.</p>}{row.httpStatus && <p>HTTP {row.httpStatus}</p>}{row.reason && <p>{row.reason.replaceAll('_', ' ')}</p>}{row.nextAttemptAt && <p>Next attempt: {webhookTime(row.nextAttemptAt, deliveries.data?.pages[0]?.timezone)}</p>}{row.response && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{row.response}</pre>}
          {receiver.kind === 'live' && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!row.retryAllowed} onClick={() => operation('retry', row, receiver)}>Retry now</Button><Button variant="outline" disabled={!row.replayAllowed} onClick={() => operation('replay', row, receiver)}>Replay</Button></div>}
          <p>Automatic retry deadline: {webhookTime(row.expiresAt, deliveries.data?.pages[0]?.timezone)}</p>
          {row.payloadRetainedUntil && <p>Payload retention deadline: {webhookTime(row.payloadRetainedUntil, deliveries.data?.pages[0]?.timezone)}</p>}
          {row.historyRetainedUntil && <p>History retained until at most {webhookTime(row.historyRetainedUntil, deliveries.data?.pages[0]?.timezone)}; storage limits may remove it sooner.</p>}
          {row.payloadAvailability === 'not_created' && <p>No payload was created for this delivery.</p>}
          {row.payloadAvailability === 'unknown' && <p>Payload availability is unknown.</p>}
          {!row.replayAllowed && <p className="text-soft-foreground">Replay unavailable: {row.replayUnavailableReason ? replayReason[row.replayUnavailableReason] : 'the payload or receiver is no longer eligible.'}</p>}
        </div>}
      </article>)}
      {deliveries.hasNextPage && <Button variant="outline" disabled={deliveries.isFetchingNextPage} onClick={() => void deliveries.fetchNextPage()}>Load older</Button>}
    </TabsContent></Tabs>
  </section>
}

const replayReason: Record<NonNullable<WebhookDelivery['replayUnavailableReason']>, string> = {
  receiver_deleted: 'the receiver was deleted.', receiver_inactive: 'activate the receiver first.',
  configuration_changed: 'the receiver configuration has changed.', task_unavailable: 'the task is deleted or its current state cannot be verified.',
  not_fresh: 'the event is no longer current.', not_terminal: 'the delivery has not reached an eligible final result.',
  synthetic_test: 'send a new explicit test instead.', payload_expired: 'the payload retention period has ended.', payload_unavailable: 'the original payload is unavailable.',
}
