import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TelegramPairingCreated, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { telegramApi } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { telegramKey, useTelegramSubscription } from '@/hooks/use-telegram'

export function TelegramInboundPanel({ projectId, receivers }: { projectId: string; receivers: WebhookReceiver[] }) {
  const [open, setOpen] = useState(false)
  return <section className="flex flex-col gap-3 rounded-md border p-3">
    <Button variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>Two-way Telegram</Button>
    {open && <TelegramSettings key={projectId} projectId={projectId} receivers={receivers} />}
  </section>
}
function TelegramSettings({ projectId, receivers }: { projectId: string; receivers: WebhookReceiver[] }) {
  const client = useQueryClient(), key = telegramKey(projectId)
  const [pairing, setPairing] = useState<TelegramPairingCreated>()
  const [groupVisibility, setGroupVisibility] = useState(false), [comparisonVerified, setComparisonVerified] = useState(false)
  useEffect(() => setComparisonVerified(false), [pairing?.pairingId])
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [confirmation, setConfirmation] = useState<{ botId: string; revision: string; disconnect: boolean; orphan?: boolean }>()
  const [showBindings, setShowBindings] = useState(false)
  const bindings = useQuery({ queryKey: [...key, 'bindings'], queryFn: ({ signal }) => telegramApi.bindings(signal), enabled: showBindings, retry: false })
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => telegramApi.list(projectId, signal), retry: false })
  useTelegramSubscription(projectId, list.data?.available === true)
  const status = useQuery({ queryKey: [...key, 'pairing', pairing?.pairingId], queryFn: ({ signal }) => telegramApi.pairing(projectId, pairing!.pairingId, signal), enabled: !!pairing, retry: false })
  const activity = useInfiniteQuery({ queryKey: [...key, 'activity'], initialPageParam: undefined as string | undefined, queryFn: ({ signal, pageParam }) => telegramApi.activity(projectId, signal, pageParam), getNextPageParam: page => page.nextCursor, enabled: list.data?.available === true, retry: false })
  useEffect(() => {
    if (!pairing) return
    const timer = setTimeout(() => { setPairing(undefined); setError('Pairing expired. Start again.') }, Math.max(0, pairing.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [pairing])
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Request failed. Refresh and try again.') }
    finally { await client.invalidateQueries({ queryKey: key }); if (mounted.current) setBusy(false) }
  }
  if (list.isPending) return <p role="status">Loading Telegram settings…</p>
  if (list.error) return <div><p role="alert">{list.error.message}</p><Button variant="outline" onClick={() => void list.refetch()}>Retry loading settings</Button></div>
  const data = list.data!
  if (!data.available) return <p>{data.reason === 'hosted' ? 'Two-way Telegram is available only in a local cockpit.' : 'Start cezar with CEZ_WEBHOOKS=1 and CEZ_CHAT_INBOUND=1 to enable replies.'}</p>
  return <div className="flex flex-col gap-3 text-sm">
    <p>Reply to a bot notification or use /tasks, /status and /reply. Access applies to all tasks in this project. Plain-text questions only send a waiting notice; read their text in the cockpit.</p>
    <p>Notification delays stay unchanged. Use one dedicated bot per project. Disconnecting does not restore Telegram’s saved update-type filter.</p>
    <label className="flex items-start gap-2"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />This bot is dedicated to this project and is not used by another application to receive messages.</label>
    {receivers.some(receiver => receiver.telegramChatId?.startsWith('-')) && <label className="flex items-start gap-2"><input type="checkbox" checked={groupVisibility} onChange={event => setGroupVisibility(event.target.checked)} />I understand that all group members can read project messages, including people without permission to control tasks.</label>}
    {error && <p role="alert" className="text-danger">{error}</p>}
    {data.receivers.map(row => {
      const receiver = receivers.find(item => item.id === row.receiverId), grants = data.grants.filter(grant => grant.receiverId === row.receiverId)
      const group = receiver?.telegramChatId?.startsWith('-') === true
      const eligible = receiver?.state === 'active' && receiver.lastTest === 'success' && receiver.profile === 'standard' && (receiver.preset === 'attention' || receiver.preset === 'all' || receiver.events.includes('task.attention_required')) && /^-?[1-9][0-9]*$/.test(receiver.telegramChatId ?? '')
      return <article key={row.receiverId} className="flex flex-col gap-2 rounded border p-3">
        <strong>{receiver?.name ?? 'Telegram receiver'}</strong><span>{row.state}</span>{row.botId && <p>Replacing pairing removes all approved people and reply links for this receiver. Other receivers keep their access.</p>}
        {!eligible && <p>Use a tested, active private or non-forum group receiver with Standard content and waiting notifications enabled.</p>}
        <div className="flex flex-wrap gap-2">
          {(!grants.length || group) && <Button disabled={busy || !eligible || !consent || (group && !groupVisibility) || !!pairing} onClick={() => void act(async () => { const next = await telegramApi.pair(projectId, row.receiverId, row.inboundRevision, false, group && groupVisibility); if (mounted.current) setPairing(next) })}>Pair person</Button>}
          {!!row.botId && <Button variant="outline" disabled={busy || !eligible || !consent || (group && !groupVisibility) || !!pairing} onClick={() => void act(async () => {
            const next = await telegramApi.pair(projectId, row.receiverId, row.inboundRevision, true, group && groupVisibility)
            if (mounted.current) setPairing(next)
          })}>Replace pairing (revoke access)</Button>}
          {!(!grants.length || group) && <Button variant="outline" disabled={busy || (row.state !== 'active' && (!eligible || (group && !groupVisibility)))} onClick={() => void act(() => telegramApi.enable(projectId, row.receiverId, row.inboundRevision, row.state !== 'active', group && groupVisibility))}>{row.state === 'active' ? 'Disable replies' : 'Enable replies'}</Button>}
        </div>
        {grants.map(grant => <div key={grant.id} className="flex flex-wrap items-center gap-2"><span>{grant.label} · Telegram ID {grant.userId}</span>
          {(['cancel', 'continue'] as const).map(permission => <label key={permission} className="flex items-center gap-1"><input type="checkbox" aria-label={`Allow ${permission} for Telegram ID ${grant.userId}`} checked={grant.permissions.includes(permission)} disabled={busy} onChange={event => {
            const permissions = event.target.checked ? [...grant.permissions, permission] : grant.permissions.filter(value => value !== permission)
            void act(() => telegramApi.permissions(projectId, grant.id, row.inboundRevision, permissions))
          }} />{permission === 'cancel' ? 'Cancel tasks' : 'Continue tasks (paid work)'}</label>)}<Button variant="outline" disabled={busy} onClick={() => void act(() => telegramApi.revoke(projectId, grant.id, row.inboundRevision))}>Revoke access</Button></div>)}
      </article>
    })}
    {pairing && <div className="flex flex-col gap-2 rounded border p-3">
      <p>Open the bot in your private Telegram chat, then press Start. Link expires in five minutes.</p>
      <a href={pairing.deepLink} target="_blank" rel="noopener noreferrer" className="underline">Open Telegram to pair</a>
      <p role="status">{status.data?.status === 'candidate' ? 'Person ready for approval.' : 'Waiting for Telegram…'}</p>
      {status.error && <p role="alert">{status.error.message}</p>}
      {status.data?.candidate?.comparisonCode && <><p>Comparison code: <strong>{status.data.candidate.comparisonCode}</strong></p><label className="flex items-start gap-2"><input type="checkbox" checked={comparisonVerified} onChange={event => setComparisonVerified(event.target.checked)} />I compared this code with the code sent privately by the bot.</label></>}
      {status.data?.candidate && <><p>{status.data.candidate.label} · Telegram ID {status.data.candidate.userId}</p><Button disabled={busy || (!!status.data.candidate.comparisonCode && !comparisonVerified)} onClick={() => void act(async () => { await telegramApi.confirm(projectId, pairing.pairingId, status.data!.inboundRevision, status.data!.candidate!.userId, comparisonVerified); if (mounted.current) setPairing(undefined) })}>Approve this person</Button></>}
      <Button variant="outline" disabled={busy} onClick={() => void act(async () => { await telegramApi.cancelPairing(projectId, pairing.pairingId); if (mounted.current) setPairing(undefined) })}>Cancel pairing</Button>
    </div>}
    {data.bots.map(bot => <div key={bot.botId} className="flex flex-wrap items-center gap-2">
      <span>Bot {bot.botId}: {bot.health.state}</span>{!!bot.health.droppedReplies && <span role="status">{bot.health.droppedReplies} bot replies dropped since this bot started. Task actions are not retried.</span>}{!bot.inboundRevision && <p>State cannot be safely read. Reset is unavailable until its integrity can be checked.</p>}
      <Button variant="outline" disabled={busy || !bot.inboundRevision} onClick={() => { if (bot.inboundRevision) setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: false }) }}>Reset access</Button>
      <Button variant="outline" disabled={busy || !bot.inboundRevision} onClick={() => { if (bot.inboundRevision) setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: true }) }}>Disconnect bot</Button>
    </div>)}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !busy) setConfirmation(undefined) }}>
      <DialogContent><DialogHeader><DialogTitle>{confirmation?.orphan ? 'Release orphaned bot?' : confirmation?.disconnect ? 'Disconnect Telegram bot?' : 'Reset Telegram access?'}</DialogTitle>
        <DialogDescription>{confirmation?.orphan ? 'This releases the bot from a missing project. Old approvals cannot be restored by bringing that project back.' : 'This removes all approved people and reply links for this bot. Pair again to restore access.'} {confirmation?.disconnect ? 'The bot will also be released for another project.' : 'The bot remains assigned to this project.'}</DialogDescription>
      </DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmation(undefined)}>Keep access</Button>
        <Button disabled={busy} onClick={() => { if (confirmation) { const action = confirmation; void act(async () => {
          if (action.orphan) await telegramApi.releaseBinding(action.botId, action.revision)
          else await (action.disconnect ? telegramApi.disconnect : telegramApi.reset)(projectId, action.botId, action.revision)
          if (mounted.current) { setConfirmation(undefined); setPairing(undefined) }
        }) } }}>Confirm removal</Button></DialogFooter></DialogContent>
    </Dialog>
    <Button variant="outline" aria-expanded={showBindings} onClick={() => setShowBindings(value => !value)}>Bot assignment diagnostics</Button>
    {showBindings && <div className="flex flex-col gap-2">
      {bindings.isPending && <p role="status">Loading assignments…</p>}
      {bindings.error && <p role="alert">{bindings.error.message}</p>}
      {bindings.data?.truncated && <p role="alert">Some assignments could not be listed. This view is incomplete.</p>}
      {bindings.data?.bindings.map(binding => <div key={binding.botId} className="flex flex-wrap items-center gap-2">
        <span>Bot {binding.botId} · project {binding.projectId} · {binding.orphaned ? 'project unavailable' : 'assigned'}</span>
        {binding.orphaned && <Button variant="outline" disabled={busy} onClick={() => setConfirmation({ botId: binding.botId, revision: binding.inboundRevision, disconnect: true, orphan: true })}>Release orphaned bot</Button>}
      </div>)}
    </div>}
    <Button variant="ghost" disabled={busy} onClick={() => void client.invalidateQueries({ queryKey: key })}>Refresh status</Button>
    <div><h4 className="font-medium">Recent Telegram actions</h4>{activity.error && <p role="alert">{activity.error.message}</p>}
      {activity.data?.pages.flatMap(page => page.entries).map(entry => <p key={entry.id} className={entry.state === 'uncertain' ? 'text-warning' : ''}>{new Date(entry.at).toLocaleString()} · {entry.kind === 'rejection_summary' ? `Bot-wide · ${entry.count} rejected messages · ${entry.reason}` : `${entry.userId} · ${entry.runId ?? '—'} · ${entry.kind} · ${entry.state} (${entry.reason})`}</p>)}
      {activity.hasNextPage && <Button variant="outline" disabled={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>Load older actions</Button>}
      {activity.data?.pages[0]?.entries.length === 0 && <p>No recorded actions.</p>}
    </div>
  </div>
}
