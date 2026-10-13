import { useState } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { CreateWebhook, UpdateWebhook, WebhookReceiver, WebhookHistoricalReceiver, WebhookDelivery } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { useHealth } from '@/api/queries'
import { useActiveProjectId } from '@/lib/project-router'
import { useWebhookList, useWebhookSubscription, webhookKey } from '@/hooks/use-webhooks'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { WebhookForm } from './webhook-form'
import { ReceiverHistory } from './webhook-history'
const guide = 'https://github.com/open-mercato/cezar/blob/main/packages/cezar/docs/webhooks.md'
type Confirmation = { title: string; text: string; run: () => Promise<unknown>; standard?: boolean; local?: boolean }
export function WebhooksSection() {
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  return <WebhookPanel key={projectId} projectId={projectId} enabled={health.data?.capabilities.webhooks === true} />
}
function WebhookPanel({ projectId, enabled }: { projectId: string; enabled: boolean }) {
  const client = useQueryClient()
  const list = useWebhookList(projectId, enabled)
  useWebhookSubscription(projectId, enabled)
  const [form, setForm] = useState<'new' | WebhookReceiver>()
  const [secret, setSecret] = useState<string>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [standardConsent, setStandardConsent] = useState(false)
  const [localConsent, setLocalConsent] = useState(false)
  const [selected, setSelected] = useState<WebhookReceiver | WebhookHistoricalReceiver>()
  const [deleted, setDeleted] = useState(false)
  const [error, setError] = useState('')
  const history = useInfiniteQuery({ queryKey: [...webhookKey(projectId), 'history'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => webhookApi.history(projectId, pageParam), getNextPageParam: page => page.nextCursor, enabled: enabled && deleted, retry: false })
  const mutation = useMutation({ mutationFn: async (run: () => Promise<unknown>) => {
    const result = await run()
    // Never put the one-time secret in React Query's shared mutation cache.
    if (result && typeof result === 'object' && 'secret' in result && typeof result.secret === 'string') setSecret(result.secret)
  }, onSuccess: async () => {
    setForm(undefined); setConfirmation(undefined); setError(''); await client.invalidateQueries({ queryKey: webhookKey(projectId) })
  }, onError: (issue: Error) => { setError(issue.message); void client.invalidateQueries({ queryKey: webhookKey(projectId) }) } })
  const openConfirmation = (value: Confirmation) => { setStandardConsent(false); setLocalConsent(false); setError(''); setConfirmation(value) }
  const operation = (action: 'retry' | 'replay', row: WebhookDelivery, receiver: WebhookReceiver) => {
    const input = { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: crypto.randomUUID() }
    openConfirmation({ title: action === 'replay' ? 'Replay this event?' : 'Retry this delivery?', text: action === 'replay' ? 'Send the same event and payload with a new 72-hour retry window. Your receiver may deduplicate it; a downstream chat may show a duplicate.' : 'Keep the same event, bytes and expiry. Rate limits, retry cooldowns and freshness checks still apply.', run: () => webhookApi[action](projectId, row.deliveryId, input) })
  }
  if (!enabled) return <section className="space-y-3"><h2 className="text-lg font-semibold">Keep up with your tasks wherever you work</h2><p>Send task updates to your own receiver, or connect a relay to your team's chat. Webhooks are optional and currently turned off.</p><details><summary className="cursor-pointer">How to enable webhooks</summary><p className="mt-2 text-sm">Start cezar with <code>CEZ_WEBHOOKS=1</code>, then restart your running cockpit. If someone else manages this server, ask them to enable webhook delivery.</p></details><a className="underline" href={guide} target="_blank" rel="noreferrer">Read the receiver guide</a></section>
  const receivers = list.data?.receivers ?? []
  const current = selected ? receivers.find(row => row.id === selected.id) ?? list.data?.history.find(row => row.id === selected.id) ?? selected : undefined
  const notice = list.data?.notice
  return <div className="min-w-0 space-y-5">
    <p className="text-sm text-soft-foreground">Deliver signed cezar JSON to a receiver you control. For Slack, Discord or phone alerts, use a <a className="underline" href={guide} target="_blank" rel="noreferrer">relay</a>. Keep cezar running for delivery.</p>
    {notice && <div role="status" className="space-y-2 rounded-md border border-warning p-3 text-sm"><p>Receiver configuration changed: {notice.action.replaceAll('_', ' ')}{notice.receiverName ? ` — ${notice.receiverName}` : ''}.</p><p>Local processes, including agents, can manage receivers and read signing keys. This notice does not prove a human made the change.</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate(() => webhookApi.acknowledge(projectId, list.data!.changeSequence))}>Acknowledge changes</Button>{receivers.filter(row => ['active', 'suspended'].includes(row.state)).map(row => <Button key={row.id} variant="outline" onClick={() => openConfirmation({ title: `Pause ${row.name}?`, text: `${row.pendingCount} pending deliveries will be cancelled. A message already in flight may still arrive.`, run: () => webhookApi.pause(projectId, row.id, row.revision) })}>Pause {row.name}</Button>)}</div></div>}
    {(error || list.error) && <p role="alert" className="text-danger">{error || list.error?.message}</p>}
    {list.data?.webhookHealth.status !== 'ready' && list.data?.webhookHealth.reason && <p role="status">{list.data.webhookHealth.reason}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={list.isPending || !!list.error} onClick={() => { setError(''); setForm('new') }}>Add receiver</Button><Button variant="outline" onClick={() => setDeleted(value => !value)}>{deleted ? 'Hide deleted receivers' : `Deleted receivers (${list.data?.historyCount ?? 0})`}</Button><Button variant="outline" onClick={() => void list.refetch()}>Refresh</Button></div>
    {list.isPending && <p>Loading receivers…</p>}
    {!list.isPending && !list.error && !receivers.length && <p>No receivers yet. Add one, copy its signing key and send a test before activating task updates.</p>}
    {receivers.map(row => <article key={row.id} className="min-w-0 space-y-3 rounded-lg border p-4"><div><h3 className="font-medium">{row.name} <span className="ml-2 rounded bg-muted px-2 py-1 text-xs font-normal capitalize">{row.state}</span></h3><p className="break-words text-sm text-soft-foreground">{row.destination} · {row.profile} · {row.pendingCount} pending · {row.inFlightCount} in flight</p>{row.consecutiveFailures > 0 && <p className="text-sm">{row.consecutiveFailures} consecutive delivery failures{row.nextProbeAt ? `; next recovery attempt ${new Date(row.nextProbeAt).toLocaleString()}` : ''}.</p>}{row.lastTest !== 'none' && <p className="text-sm">Last test: {row.lastTest.replaceAll('_', ' ')}{row.activationBlocked ? '. Activation requires a successful test of this configuration.' : ''}</p>}</div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={mutation.isPending} onClick={() => { const input = { expectedRevision: row.revision, deliveryRevision: row.deliveryRevision, operationId: crypto.randomUUID() }; if (row.state === 'suspended') openConfirmation({ title: 'Test and recover delivery?', text: `A successful test will return this receiver to Active and release eligible pending deliveries (currently ${row.pendingCount}; this count can change). Expired or stale events will not be sent.`, run: () => webhookApi.test(projectId, row.id, input) }); else mutation.mutate(() => webhookApi.test(projectId, row.id, input)) }}>Send test</Button>
        {['inactive', 'disabled', 'paused'].includes(row.state) ? <Button disabled={mutation.isPending || row.activationBlocked || row.state === 'disabled' && row.lastTest !== 'success'} onClick={() => openConfirmation({ title: row.state === 'paused' ? 'Resume receiver?' : 'Activate receiver?', text: `Only events captured after this activation will be sent. No earlier backlog.${row.lastTest === 'transient_failure' ? ' The latest test failed temporarily; delivery may still fail.' : ''}`, standard: row.profile === 'standard', local: row.allowLocalNetwork, run: () => row.state === 'paused' ? webhookApi.resume(projectId, row.id, row.revision) : webhookApi.activate(projectId, row.id, row.revision) })}>{row.state === 'paused' ? 'Resume' : 'Activate'}</Button> : <Button variant="outline" onClick={() => openConfirmation({ title: 'Pause receiver?', text: `${row.pendingCount} pending deliveries will be cancelled. A message already in flight may still arrive.`, run: () => webhookApi.pause(projectId, row.id, row.revision) })}>Pause</Button>}
        <Button variant="outline" onClick={() => setForm(row)}>Edit</Button><Button variant="outline" onClick={() => setSelected(row)}>History</Button>
        <Button variant="outline" onClick={() => openConfirmation({ title: 'Rotate signing key?', text: 'Both keys sign deliveries for 24 hours. Update your receiver during that overlap. Another graceful rotation is unavailable until the overlap ends.', run: () => webhookApi.rotate(projectId, row.id, row.revision, 'graceful') })} disabled={!!row.retiredKeyExpiresAt && Date.parse(row.retiredKeyExpiresAt) > Date.now()}>Rotate key</Button>
        <Button variant="outline" onClick={() => openConfirmation({ title: 'Revoke old keys immediately?', text: 'All previous keys stop signing immediately. Your receiver must use the new key; deliveries may fail until you update it.', run: () => webhookApi.rotate(projectId, row.id, row.revision, 'revoke_now') })}>Revoke old keys</Button>
        <Button variant="outline" onClick={() => openConfirmation({ title: 'Delete receiver?', text: `${row.pendingCount} pending deliveries will be cancelled and its keys removed. Masked history remains for its retention period. A message already in flight may still arrive.`, run: () => webhookApi.remove(projectId, row.id, row.revision) })}>Delete</Button>
      </div>{row.retiredKeyExpiresAt && <p className="text-sm">Previous key expires {new Date(row.retiredKeyExpiresAt).toLocaleString()}.</p>}
    </article>)}
    {deleted && <section className="space-y-2"><h3 className="font-medium">Deleted receiver history</h3>{history.error && <p role="alert">{history.error.message}</p>}{history.data?.pages.flatMap(page => page.items).map(row => <Button key={row.id} variant="outline" onClick={() => setSelected(row)}>{row.name} — deleted {new Date(row.deletedAt).toLocaleDateString()}</Button>)}{history.hasNextPage && <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load older receivers</Button>}</section>}
    <Dialog open={form !== undefined && !confirmation} onOpenChange={open => { if (!open && !mutation.isPending) setForm(undefined) }}><DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{form === 'new' ? 'Add receiver' : 'Edit receiver'}</DialogTitle><DialogDescription>Save a destination for signed cezar JSON. New and changed configurations remain Inactive until you activate them.</DialogDescription></DialogHeader>{form && <WebhookForm key={form === 'new' ? 'new' : `${form.id}-${form.revision}`} receiver={form === 'new' ? undefined : form} pending={mutation.isPending} save={value => {
      if (form === 'new') mutation.mutate(() => webhookApi.create(projectId, value as CreateWebhook))
      else { const row = form; openConfirmation({ title: 'Save receiver changes?', text: `Delivery changes return this receiver to Inactive and cancel its ${row.pendingCount} pending deliveries. A rename alone keeps delivery active. A message already in flight may still arrive.`, run: () => webhookApi.update(projectId, row.id, value as UpdateWebhook) }) }
    }} />}{error && <p role="alert" className="text-danger">{error}</p>}</DialogContent></Dialog>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !mutation.isPending) setConfirmation(undefined) }}><DialogContent><DialogHeader><DialogTitle>{confirmation?.title}</DialogTitle><DialogDescription>{confirmation?.text}</DialogDescription></DialogHeader>{confirmation?.standard && <label className="flex gap-2 text-sm"><input type="checkbox" checked={standardConsent} onChange={event => setStandardConsent(event.target.checked)} />I understand Standard sends task titles, questions and error text to this receiver.</label>}{confirmation?.local && <label className="flex gap-2 text-sm"><input type="checkbox" checked={localConsent} onChange={event => setLocalConsent(event.target.checked)} />I allow delivery to this computer or private network.</label>}{error && <p role="alert" className="text-danger">{error}</p>}<DialogFooter><Button variant="outline" disabled={mutation.isPending} onClick={() => setConfirmation(undefined)}>Cancel</Button><Button disabled={mutation.isPending || !!confirmation?.standard && !standardConsent || !!confirmation?.local && !localConsent} onClick={() => confirmation && mutation.mutate(confirmation.run)}>{mutation.isPending ? 'Working…' : 'Confirm'}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!secret} onOpenChange={open => { if (!open) setSecret(undefined) }}><DialogContent><DialogHeader><DialogTitle>Save your signing key</DialogTitle><DialogDescription>This key is shown once. Store it in your receiver before sending a test.</DialogDescription></DialogHeader><code className="block break-all rounded bg-muted p-3">{secret}</code><DialogFooter><Button variant="outline" onClick={() => { if (secret) void navigator.clipboard.writeText(secret).catch(() => setError('Could not copy; select and copy the key manually.')) }}>Copy key</Button><Button onClick={() => setSecret(undefined)}>I've saved the key</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!current} onOpenChange={open => { if (!open) setSelected(undefined) }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{current?.name} history</DialogTitle><DialogDescription>Retained delivery results and configuration activity for this project.</DialogDescription></DialogHeader>{current && <ReceiverHistory key={current.id} projectId={projectId} receiver={current} operation={operation} />}</DialogContent></Dialog>
  </div>
}
