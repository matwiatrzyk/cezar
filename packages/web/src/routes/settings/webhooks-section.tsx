import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateWebhook, UpdateWebhook, WebhookReceiver, WebhookHistoricalReceiver, WebhookDelivery } from '@open-mercato/cezar-api-client'
import { webhookApi, getSelfUpdate } from '@/api/client'
import { useHealth } from '@/api/queries'
import { useActiveProjectId } from '@/lib/project-router'
import { useWebhookList, useWebhookSubscription, webhookKey } from '@/hooks/use-webhooks'
import { useWebhookToasts } from '@/hooks/use-webhook-toasts'
import { Pill } from '@/components/pill'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { WebhookForm, eventLabels, webhookDraft } from './webhook-form'
import { WebhookTestFeedback, type PendingWebhookTest } from './webhook-test-feedback'
import { ReceiverHistory } from './webhook-history'
import { endpointHealthTone, webhookGuide, webhookTime } from './webhook-presentation'
type Confirmation = { title: string; text: string; run: () => Promise<unknown>; standard?: boolean; local?: boolean; receiver?: WebhookReceiver }
export function WebhooksSection() {
  const projectId = useActiveProjectId() ?? 'default'
  const health = useHealth()
  return <WebhookPanel key={projectId} projectId={projectId} enabled={health.data?.capabilities.webhooks === true} unsupportedPlatform={health.data?.capabilities.webhooksUnavailableReason === 'unsupported_platform'} />
}
function WebhookPanel({ projectId, enabled, unsupportedPlatform }: { projectId: string; enabled: boolean; unsupportedPlatform: boolean }) {
  const client = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const view = useRef({ mounted: false, token: Symbol() })
  useLayoutEffect(() => { view.current = { mounted: true, token: Symbol() }; return () => { view.current.mounted = false } }, [location])
  // Router keys return on Back/Forward; a visit token must never be reused.
  const currentView = (token: symbol) => view.current.mounted && view.current.token === token
  const endpoint = searchParams.get('endpoint') ?? ''
  const requestedTab = searchParams.get('tab') ?? 'settings'
  const validEndpoint = /^[A-Za-z0-9_-]{1,128}$/.test(endpoint)
  const validTab = ['settings', 'deliveries', 'activity'].includes(requestedTab)
  const historyTab = requestedTab === 'activity' ? 'activity' : 'deliveries'
  const navigationSearch = useRef(searchParams.toString())
  useLayoutEffect(() => { navigationSearch.current = searchParams.toString() }, [searchParams])
  const navigateReceiver = (id?: string, tab = 'deliveries') => {
    const next = new URLSearchParams(navigationSearch.current)
    if (id) { next.set('endpoint', id); next.set('tab', tab) }
    else { next.delete('endpoint'); next.delete('tab') }
    // Tabs can request selection on both mouse-down and focus before React commits.
    // Reserve the target synchronously so one interaction creates one history entry.
    if (next.toString() === navigationSearch.current) return
    navigationSearch.current = next.toString()
    setSearchParams(next)
  }
  const metadata = useQuery({ queryKey: ['workspace', 'self-update'], queryFn: ({ signal }) => getSelfUpdate({ signal }), retry: false })
  const guide = webhookGuide(metadata.data)
  const list = useWebhookList(projectId, enabled)
  useWebhookSubscription(projectId, enabled)
  useWebhookToasts(projectId, enabled ? list.data : undefined)
  const [form, setForm] = useState<'new' | WebhookReceiver>()
  const [draft, setDraft] = useState(() => webhookDraft())
  const [stale, setStale] = useState(false)
  const [copyMessage, setCopyMessage] = useState('')
  const [secret, setSecret] = useState<string>()
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [standardConsent, setStandardConsent] = useState(false)
  const [localConsent, setLocalConsent] = useState(false)
  const openedSettings = useRef<string | undefined>(undefined)
  const knownReceiver = list.data?.receivers.find(row => row.id === endpoint) ?? list.data?.history.find(row => row.id === endpoint)
  const resolution = useQuery({ queryKey: [...webhookKey(projectId), 'resolve', endpoint, historyTab],
    queryFn: async () => (await (historyTab === 'activity' ? webhookApi.activity(projectId, endpoint) : webhookApi.deliveries(projectId, endpoint))).receiver,
    enabled: enabled && validEndpoint && validTab && requestedTab !== 'settings' && !knownReceiver, retry: false })
  useEffect(() => {
    if (enabled && validEndpoint && requestedTab === 'settings') {
      const receiver = list.data?.receivers.find(row => row.id === endpoint)
      if (receiver && openedSettings.current !== endpoint) {
        openedSettings.current = endpoint; setForm(receiver); setDraft(webhookDraft(receiver)); setStale(false); setError('')
      }
    } else if (openedSettings.current) {
      openedSettings.current = undefined; setForm(undefined); setDraft(webhookDraft()); setStale(false)
    }
  }, [enabled, endpoint, validEndpoint, requestedTab, list.data])
  const [deleted, setDeleted] = useState(false)
  const [error, setError] = useState('')
  const [pendingTest, setPendingTest] = useState<PendingWebhookTest & { viewKey: string }>()
  // Retire the explicit test on navigation, including Back to an earlier location key.
  useLayoutEffect(() => { setPendingTest(undefined) }, [location.key])
  const sendTest = async (row: WebhookReceiver, input: { expectedRevision: number; deliveryRevision: number; operationId: string }) => {
    const key = view.current.token
    const result = await webhookApi.test(projectId, row.id, input)
    if (!currentView(key)) return
    setPendingTest({ viewKey: location.key, deliveryId: result.deliveryId, receiverId: row.id, initialState: row.state, deliveryRevision: row.deliveryRevision })
  }
  const history = useInfiniteQuery({ queryKey: [...webhookKey(projectId), 'history'], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => webhookApi.history(projectId, pageParam), getNextPageParam: page => page.nextCursor, enabled: enabled && deleted, retry: false })
  const mutation = useMutation({ onMutate: () => ({ viewKey: view.current.token }), mutationFn: async (run: () => Promise<unknown>) => {
    const key = view.current.token
    const result = await run()
    // Never put the one-time secret in React Query's shared mutation cache.
    if (currentView(key) && result && typeof result === 'object' && 'secret' in result && typeof result.secret === 'string') { setCopyMessage(''); setSecret(result.secret) }
  }, onSuccess: async (_result, _run, context) => {
    if (!context || !currentView(context.viewKey)) { await client.invalidateQueries({ queryKey: webhookKey(projectId) }); return }
    if (form && endpoint && requestedTab === 'settings') navigateReceiver()
    setForm(undefined); setDraft(webhookDraft()); setStale(false); setConfirmation(undefined); setError(''); await client.invalidateQueries({ queryKey: webhookKey(projectId) })
  }, onError: (issue: Error, _run, context) => { if (!context || !currentView(context.viewKey)) { void client.invalidateQueries({ queryKey: webhookKey(projectId) }); return } setError(issue.message); if ('status' in issue && issue.status === 409) setStale(true); void client.invalidateQueries({ queryKey: webhookKey(projectId) }) } })
  const openConfirmation = (value: Confirmation) => { setStandardConsent(false); setLocalConsent(false); setError(''); setStale(false); setConfirmation(value) }
  const operation = (action: 'retry' | 'replay', row: WebhookDelivery, receiver: WebhookReceiver) => {
    const input = { expectedRevision: receiver.revision, deliveryRevision: receiver.deliveryRevision, operationId: crypto.randomUUID() }
    openConfirmation({ title: action === 'replay' ? 'Replay this event?' : 'Retry this delivery?', text: action === 'replay' ? 'Send the same event and payload with a new 72-hour retry window. Your receiver may deduplicate it; a downstream chat may show a duplicate.' : 'Keep the same event, bytes and expiry. Rate limits, retry cooldowns and freshness checks still apply.', run: () => webhookApi[action](projectId, row.deliveryId, input) })
  }
  if (unsupportedPlatform) return <section className="space-y-3"><h2 className="text-lg font-semibold">Webhooks are unsupported on this server platform</h2><p>Webhook delivery requires a Linux server with /proc available for safe ownership checks. macOS and Windows are not supported.</p><a className="underline" href={guide.href} target="_blank" rel="noreferrer">Read the receiver guide</a></section>
  if (!enabled) return <section className="space-y-3"><h2 className="text-lg font-semibold">Keep up with your tasks wherever you work</h2><p>Send task updates to your own receiver, or connect a relay to your team's chat. Webhooks are optional and currently turned off.</p><details><summary className="cursor-pointer">How to enable webhooks</summary><p className="mt-2 text-sm">Webhook delivery currently requires Linux with /proc available for safe ownership checks. Start cezar with <code>CEZ_WEBHOOKS=1</code>, then restart your running cockpit. If someone else manages this server, ask them to enable webhook delivery.</p></details><a className="underline" href={guide.href} target="_blank" rel="noreferrer">Read the receiver guide</a><p className="text-sm text-soft-foreground">{guide.note}</p></section>
  const receivers = list.data?.receivers ?? []
  const current = validEndpoint && validTab && requestedTab !== 'settings' ? knownReceiver ?? resolution.data : undefined
  const notice = list.data?.notice
  const noticeReceiver = notice?.receiverId ? receivers.find(row => row.id === notice.receiverId) : undefined
  const latestEdit = form && form !== 'new' ? receivers.find(row => row.id === form.id) : undefined
  const reconciliation = stale && <div className="space-y-3 rounded border border-warning p-3 text-sm" role="alert">
    <p>The receiver changed or this operation is no longer eligible. Nothing was applied. Review the latest state and confirm again.</p>
    {form && form !== 'new' ? <>
      <p>Your draft is preserved. Compare it with the latest configuration below. Keeping the draft will replace those settings; a blank URL keeps the latest destination.</p>
      {list.isFetching ? <p>Loading latest configuration…</p> : list.error ? <p>Could not load the latest configuration.</p> : latestEdit ? <><p>Latest revision {latestEdit.revision} · {latestEdit.state}</p><ActivationSummary receiver={latestEdit} projectId={projectId} /></> : <p>This receiver is no longer available. Close this edit to return to the list.</p>}
      <Button variant="outline" disabled={list.isFetching} onClick={() => void list.refetch()}>Refresh latest configuration</Button>
      <Button disabled={!latestEdit || list.isFetching || !!list.error} onClick={() => { if (latestEdit) { setForm(latestEdit); setStale(false); setConfirmation(undefined); setError(''); } }}>Keep draft and review against latest</Button>
    </> : <p>Cancel this confirmation, inspect the refreshed receiver or history, and choose the action again. The previous consent will not be reused.</p>}
  </div>
  return <div className="min-w-0 space-y-5">
    <p className="text-sm text-soft-foreground">Deliver signed cezar JSON to a receiver you control. For Slack, Discord or phone alerts, use a <a className="underline" href={guide.href} target="_blank" rel="noreferrer">relay</a>. Keep cezar running on Linux with /proc available for delivery.</p><p className="text-xs text-soft-foreground">{guide.note}</p>
    {pendingTest && pendingTest.viewKey === location.key && <WebhookTestFeedback key={pendingTest.deliveryId} projectId={projectId} test={pendingTest} openHistory={id => navigateReceiver(id)} />}
    {notice && <div role="status" className="space-y-2 rounded-md border border-warning p-3 text-sm"><p>Receiver configuration changed: {notice.action.replaceAll('_', ' ')}{notice.receiverName ? ` — ${notice.receiverName}` : ''}.</p><p>{notice.destination ? `${notice.destination} · ` : ''}{webhookTime(notice.at)} · Reported source: {notice.source ?? 'unknown'}</p><p>Local processes, including agents, can manage receivers and read signing keys. This notice does not prove a human made the change.</p><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate(() => webhookApi.acknowledge(projectId, list.data!.changeSequence))}>Acknowledge changes</Button>{notice?.receiverId && <><Button variant="outline" onClick={() => navigateReceiver(notice.receiverId, 'activity')}>View change activity</Button><Button variant="outline" onClick={() => navigateReceiver(notice.receiverId)}>View receiver history</Button></>}{noticeReceiver && <Button variant="outline" onClick={() => openConfirmation({ title: `Delete ${noticeReceiver.name}?`, text: `${noticeReceiver.pendingCount} pending deliveries will be cancelled. A message already in flight may still arrive. Masked history remains for its retention period.`, run: () => webhookApi.remove(projectId, noticeReceiver.id, noticeReceiver.revision) })}>Delete changed receiver</Button>}{(noticeReceiver && ['active', 'suspended'].includes(noticeReceiver.state) ? [noticeReceiver] : []).map(row => <Button key={row.id} variant="outline" onClick={() => openConfirmation({ title: `Pause ${row.name}?`, text: `${row.pendingCount} pending deliveries will be cancelled. A message already in flight may still arrive.`, run: () => webhookApi.pause(projectId, row.id, row.revision) })}>Pause {row.name}</Button>)}</div></div>}
    {endpoint && (!validEndpoint || !validTab) && <p role="alert">This receiver link is invalid.</p>}
    {validEndpoint && requestedTab === 'settings' && !list.isPending && !list.error && !receivers.some(row => row.id === endpoint) && <p role="alert">Receiver settings are unavailable. The receiver may have been deleted. <Button variant="outline" onClick={() => navigateReceiver(endpoint, 'deliveries')}>View retained history</Button></p>}
    {validEndpoint && validTab && requestedTab !== 'settings' && !current && <p role="status">{resolution.error ? 'Receiver history is unavailable or its retention period has ended.' : 'Loading receiver history…'}</p>}
    {(error || list.error) && <p role="alert" className="text-danger">{error || list.error?.message}</p>}
    {list.data?.webhookHealth.status !== 'ready' && list.data?.webhookHealth.reason && <p role="status">{list.data.webhookHealth.reason}</p>}
    <div className="flex flex-wrap gap-2"><Button disabled={list.isPending || !!list.error} onClick={() => { setError(''); setStale(false); setDraft(webhookDraft()); setForm('new') }}>Add receiver</Button><Button variant="outline" onClick={() => setDeleted(value => !value)}>{deleted ? 'Hide deleted receivers' : `Deleted receivers (${list.data?.historyCount ?? 0})`}</Button><Button variant="outline" onClick={() => void list.refetch()}>Refresh</Button></div>
    {list.isPending && <p>Loading receivers…</p>}
    {!list.isPending && !list.error && !receivers.length && <p>No receivers yet. Add one, copy its signing key and send a test before activating task updates.</p>}
    {receivers.map(row => <article key={row.id} className="min-w-0 space-y-3 rounded-lg border p-4"><div><h3 className="font-medium">{row.name} <Pill className="ml-2 capitalize" dot={endpointHealthTone[row.state]}>{row.state}</Pill></h3><p className="break-words text-sm text-soft-foreground">{row.destination} · {row.profile} · {row.pendingCount} pending · {row.inFlightCount} in flight</p>{row.consecutiveFailures > 0 && <p className="text-sm">{row.consecutiveFailures} consecutive delivery failures{row.nextProbeAt ? `; next recovery attempt ${webhookTime(row.nextProbeAt)}` : ''}.</p>}{row.lastTest !== 'none' && <p className="text-sm">Last test: {row.lastTest.replaceAll('_', ' ')}{row.activationBlocked ? '. Activation requires a successful test of this configuration.' : ''}</p>}</div>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={mutation.isPending} onClick={() => { const input = { expectedRevision: row.revision, deliveryRevision: row.deliveryRevision, operationId: crypto.randomUUID() }; if (row.state === 'suspended') openConfirmation({ title: 'Test and recover delivery?', text: `A successful test will return this receiver to Active and release eligible pending deliveries (currently ${row.pendingCount}; this count can change). Expired or stale events will not be sent.`, run: () => sendTest(row, input) }); else mutation.mutate(() => sendTest(row, input)) }}>{row.state === 'suspended' ? 'Test and recover' : 'Send test'}</Button>
        {['inactive', 'disabled', 'paused'].includes(row.state) ? <Button disabled={mutation.isPending || row.activationBlocked || row.state === 'disabled' && row.lastTest !== 'success'} onClick={() => openConfirmation({ title: row.state === 'paused' ? 'Resume receiver?' : 'Activate receiver?', text: `Only events captured after this activation will be sent. No earlier backlog.${row.lastTest === 'transient_failure' ? ' The latest test failed temporarily; delivery may still fail.' : ''}`, receiver: row, standard: row.profile === 'standard', local: row.allowLocalNetwork, run: () => row.state === 'paused' ? webhookApi.resume(projectId, row.id, row.revision) : webhookApi.activate(projectId, row.id, row.revision) })}>{row.state === 'paused' ? 'Resume' : 'Activate'}</Button> : <Button variant="outline" onClick={() => openConfirmation({ title: 'Pause receiver?', text: `${row.pendingCount} pending deliveries will be cancelled. A message already in flight may still arrive.`, run: () => webhookApi.pause(projectId, row.id, row.revision) })}>Pause</Button>}
        <Button variant="outline" onClick={() => { setDraft(webhookDraft(row)); setStale(false); setError(''); setForm(row); navigateReceiver(row.id, 'settings') }}>Edit</Button><Button variant="outline" onClick={() => navigateReceiver(row.id)}>History</Button>
        <Button variant="outline" onClick={() => openConfirmation({ title: 'Rotate signing key?', text: 'Both keys sign deliveries for 24 hours. Update your receiver during that overlap. Another graceful rotation is unavailable until the overlap ends.', run: () => webhookApi.rotate(projectId, row.id, row.revision, 'graceful') })} disabled={!!row.retiredKeyExpiresAt && Date.parse(row.retiredKeyExpiresAt) > Date.now()}>Rotate key</Button>
        <Button variant="outline" onClick={() => openConfirmation({ title: 'Revoke old keys immediately?', text: 'All previous keys stop signing immediately. Your receiver must use the new key; deliveries may fail until you update it. Remove all old verifier keys from your receiver immediately, especially compromised keys: cezar cannot revoke keys your receiver still accepts.', run: () => webhookApi.rotate(projectId, row.id, row.revision, 'revoke_now') })}>Revoke old keys</Button>
        <Button variant="outline" onClick={() => openConfirmation({ title: 'Delete receiver?', text: `${row.pendingCount} pending deliveries will be cancelled and its keys removed. Masked history remains for its retention period. A message already in flight may still arrive.`, run: () => webhookApi.remove(projectId, row.id, row.revision) })}>Delete</Button>
      </div>{row.retiredKeyExpiresAt && <p className="text-sm">Previous key expires {webhookTime(row.retiredKeyExpiresAt)}.</p>}
    </article>)}
    {deleted && <section className="space-y-2"><h3 className="font-medium">Deleted receiver history</h3>{history.error && <p role="alert">{history.error.message}</p>}{history.data?.pages.flatMap(page => page.items).map(row => <Button key={row.id} variant="outline" onClick={() => navigateReceiver(row.id)}>{row.name} — deleted {webhookTime(row.deletedAt)}</Button>)}{history.hasNextPage && <Button variant="outline" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>Load older receivers</Button>}</section>}
    <Dialog open={form !== undefined && !confirmation} onOpenChange={open => { if (!open && !mutation.isPending) { setForm(undefined); setDraft(webhookDraft()); setStale(false); if (endpoint) navigateReceiver() } }}><DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>{form === 'new' ? 'Add receiver' : 'Edit receiver'}</DialogTitle><DialogDescription>Save a destination for signed cezar JSON. New and changed configurations remain Inactive until you activate them.</DialogDescription></DialogHeader>{form && <WebhookForm key={form === 'new' ? 'new' : `${form.id}-${form.revision}`} receiver={form === 'new' ? undefined : form} guideHref={guide.href} draft={draft} setDraft={setDraft} pending={mutation.isPending} blocked={stale} save={value => {
      if (form === 'new') mutation.mutate(() => webhookApi.create(projectId, value as CreateWebhook))
      else { const row = form; openConfirmation({ title: 'Save receiver changes?', text: `Delivery changes return this receiver to Inactive and cancel its ${row.pendingCount} pending deliveries. A rename alone keeps delivery active. A message already in flight may still arrive.`, run: () => webhookApi.update(projectId, row.id, value as UpdateWebhook) }) }
    }} />}{reconciliation}{error && <p role="alert" className="text-danger">{error}</p>}</DialogContent></Dialog>
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !mutation.isPending) setConfirmation(undefined) }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{confirmation?.title}</DialogTitle><DialogDescription>{confirmation?.text}</DialogDescription></DialogHeader>{confirmation?.receiver && <ActivationSummary receiver={confirmation.receiver} projectId={projectId} />}{confirmation?.standard && <label className="flex gap-2 text-sm"><input type="checkbox" checked={standardConsent} onChange={event => setStandardConsent(event.target.checked)} />I understand Standard sends task titles, questions and error text to this receiver.</label>}{confirmation?.local && <label className="flex gap-2 text-sm"><input type="checkbox" checked={localConsent} onChange={event => setLocalConsent(event.target.checked)} />I allow delivery to this computer or private network.</label>}{reconciliation}{error && <p role="alert" className="text-danger">{error}</p>}<DialogFooter><Button variant="outline" disabled={mutation.isPending} onClick={() => setConfirmation(undefined)}>Cancel</Button><Button disabled={mutation.isPending || stale || !!confirmation?.standard && !standardConsent || !!confirmation?.local && !localConsent} onClick={() => confirmation && mutation.mutate(confirmation.run)}>{mutation.isPending ? 'Working…' : 'Confirm'}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!secret} onOpenChange={open => { if (!open) setSecret(undefined) }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>Save your signing key</DialogTitle><DialogDescription>This key is shown once. Store it in your receiver before sending a test. If you close this dialog without saving it, use Rotate key to get a new key and update your receiver; the lost key cannot be shown again. If rotation is unavailable during an overlap, use Revoke old keys and install the replacement immediately.</DialogDescription></DialogHeader><code tabIndex={0} className="block select-text break-all rounded bg-muted p-3">{secret}</code>{copyMessage && <p role="status">{copyMessage}</p>}<DialogFooter><Button variant="outline" onClick={async () => { try { if (!secret || !navigator.clipboard?.writeText) throw new Error('Clipboard unavailable'); await navigator.clipboard.writeText(secret); setCopyMessage('Key copied. Store it safely in your receiver.'); } catch { setCopyMessage('Could not copy; select and copy the key manually before closing this dialog.'); } }}>Copy key</Button><Button onClick={() => setSecret(undefined)}>I've saved the key</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={!!current} onOpenChange={open => { if (!open) navigateReceiver() }}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{current?.name} history</DialogTitle><DialogDescription>Retained delivery results and configuration activity for this project.</DialogDescription></DialogHeader>{current && <ReceiverHistory key={current.id} projectId={projectId} receiver={current} tab={historyTab} onTabChange={tab => navigateReceiver(current.id, tab)} operation={operation} />}</DialogContent></Dialog>
  </div>
}

function ActivationSummary({ receiver, projectId }: { receiver: WebhookReceiver; projectId: string }) {
  const events = receiver.preset === 'custom' ? receiver.events : receiver.preset === 'all'
    ? ['task.attention_required', 'task.review_ready', 'task.finished', 'task.failed', 'task.cancelled'] as const
    : ['task.attention_required', 'task.review_ready', 'task.finished', 'task.failed'] as const
  return <div className="min-w-0 space-y-2 text-sm">
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 [overflow-wrap:anywhere]">
      <dt>Receiver</dt><dd>{receiver.name}</dd><dt>Destination</dt><dd>{receiver.destination}</dd>
      <dt>Project</dt><dd>{projectId}</dd><dt>Profile</dt><dd>{receiver.profile === 'standard' ? 'Standard' : 'Minimal'}</dd>
      <dt>Events</dt><dd>{events.map(type => <div key={type}>{eventLabels[type]}</div>)}</dd>
      <dt>Task scope</dt><dd>{receiver.scope === 'every_task' ? 'Every task' : 'Main tasks and child questions'}</dd>
      <dt>Private network</dt><dd>{receiver.allowLocalNetwork ? 'Allowed' : 'Not allowed'}</dd>
      <dt>Grace period</dt><dd>{receiver.graceSeconds} seconds</dd>
      <dt>Scheduled failures</dt><dd>{receiver.preset === 'all' || receiver.includeScheduledFailures ? 'Included' : 'Excluded'}</dd>
    </dl>
    {receiver.destination.startsWith('http:') && <p role="alert">HTTP is unencrypted. People on the network may read notification content. Use HTTPS where possible.</p>}
  </div>
}
