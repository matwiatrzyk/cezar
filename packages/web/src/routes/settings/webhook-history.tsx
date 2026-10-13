import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import type { WebhookReceiver, WebhookHistoricalReceiver, WebhookDelivery } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { webhookKey } from '@/hooks/use-webhooks'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { eventLabels } from './webhook-form'
export function ReceiverHistory({ projectId, receiver, operation }: { projectId: string; receiver: WebhookReceiver | WebhookHistoricalReceiver; operation: (action: 'retry' | 'replay', row: WebhookDelivery, receiver: WebhookReceiver) => void }) {
  const [tab, setTab] = useState<'deliveries' | 'activity'>('deliveries')
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
    {receiver.kind === 'history' && <p className="rounded-md border p-3 text-sm">Deleted receiver — read-only history. Configuration and signing keys are no longer available.</p>}
    <div role="tablist" aria-label="Receiver history" className="flex gap-2"><Button role="tab" aria-selected={tab === 'deliveries'} variant={tab === 'deliveries' ? 'primary' : 'outline'} onClick={() => setTab('deliveries')}>Deliveries</Button><Button role="tab" aria-selected={tab === 'activity'} variant={tab === 'activity' ? 'primary' : 'outline'} onClick={() => setTab('activity')}>Activity</Button></div>
    {tab === 'activity' ? <div className="space-y-2">
      {activity.isPending && <p>Loading activity…</p>}{activity.error && <p role="alert">{activity.error.message}</p>}
      {activity.data?.items.map(row => <div key={row.id} className="rounded border p-3 text-sm"><time>{new Date(row.at).toLocaleString()}</time> · {row.action.replaceAll('_', ' ')} · {row.source}{row.revision !== undefined && <span> · Revision {row.revision}</span>}{row.fields.length > 0 && <p>Changed fields: {row.fields.join(', ')}</p>}{row.detail && <p>{row.detail}</p>}</div>)}
      {activity.data?.items.length === 0 && <p>No retained activity.</p>}{activity.data?.hasMore && <p className="text-sm">Showing the latest 100 actions.</p>}
    </div> : <>
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setTaskId(search.trim()) }}><label className="flex-1 text-sm">Task ID (optional)<Input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find retained deliveries for a task" /></label><Button type="submit" variant="outline">Find task</Button></form>
      <label className="block text-sm">Result filter <select className="ml-2 rounded border bg-background p-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={filter} onChange={event => setFilter(event.target.value)}>{['all', 'pending', 'in_flight', 'retrying', 'blocked_policy', 'delivered', 'failed', 'superseded', 'cancelled', 'dropped'].map(value => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label>
      <p className="text-sm text-soft-foreground">Showing {rows.length ? `1–${rows.length}` : '0'} of {deliveries.data?.pages[0]?.total ?? 0} retained records. Result filters apply to loaded entries. Times shown in {deliveries.data?.pages[0]?.timezone ?? 'your local timezone'}.</p>
      {deliveries.isPending && <p>Loading deliveries…</p>}{deliveries.error && <p role="alert">{deliveries.error.message}</p>}
      {!deliveries.isPending && visible.length === 0 && <p>No matching retained deliveries.</p>}
      {visible.map(row => <article key={row.deliveryId} className="min-w-0 rounded-md border p-3 text-sm">
        <button className="w-full text-left" type="button" aria-expanded={expanded === row.deliveryId} onClick={() => setExpanded(current => current === row.deliveryId ? undefined : row.deliveryId)}><span className="font-medium">{eventLabels[row.eventType]}</span> · {row.status.replaceAll('_', ' ')}<span className="block text-soft-foreground">{new Date(row.createdAt).toLocaleString()} · {row.attempts} attempt{row.attempts === 1 ? '' : 's'}</span></button>
        {expanded === row.deliveryId && <div className="mt-3 space-y-2 break-words"><p>Destination: {row.destination}</p><p>Event: {row.eventId}</p><p>Delivery: {row.deliveryId}</p>{row.taskId && <p>Task: {row.taskId}</p>}{row.httpStatus && <p>HTTP {row.httpStatus}</p>}{row.reason && <p>{row.reason.replaceAll('_', ' ')}</p>}{row.nextAttemptAt && <p>Next attempt: {new Date(row.nextAttemptAt).toLocaleString()}</p>}{row.response && <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2">{row.response}</pre>}
          {receiver.kind === 'live' && <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!row.retryAllowed} onClick={() => operation('retry', row, receiver)}>Retry now</Button><Button variant="outline" disabled={!row.replayAllowed} onClick={() => operation('replay', row, receiver)}>Replay</Button></div>}
          {!row.replayAllowed && ['delivered', 'failed'].includes(row.status) && <p className="text-soft-foreground">Replay requires an active matching receiver, a fresh event and payload retained for seven days after completion.</p>}
        </div>}
      </article>)}
      {deliveries.hasNextPage && <Button variant="outline" disabled={deliveries.isFetchingNextPage} onClick={() => void deliveries.fetchNextPage()}>Load older</Button>}
    </>}
  </section>
}
