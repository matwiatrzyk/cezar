import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TelegramInboundGrant, TelegramPairingCreated, TelegramSetupActivated, TelegramSetupBegun, TelegramSetupStatus, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { cez, telegramApi, unwrap } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { telegramKey, useTelegramSubscription } from '@/hooks/use-telegram'

const telegramSetupErrorMessages: Record<string, string> = {
  invalid_token: 'Telegram rejected the saved bot token. Copy it again from @BotFather and test the receiver.',
  blocked: 'Telegram blocked this bot. Unblock or recreate it, then try again.',
  conflict: 'Telegram settings changed. Refresh the receiver and start setup again.',
  damaged_state: 'Telegram access is damaged. Reset access below, then start setup again.',
  vault_unavailable: 'The bot token store is unavailable. Restore it, then retry setup.',
  insufficient_permission: 'Choose the required notification permission before activating.',
  mode_mismatch: 'The setup mode changed. Start setup again.',
}

const telegramHealthLabels: Record<string, string> = { stopped: 'Not running', polling: 'Connected and listening', backoff: 'Temporarily retrying', blocked: 'Blocked — check the bot settings', conflict: 'Another cockpit owns this bot', 'credentials-unavailable': 'Bot credentials unavailable' }
const receiverStateLabels: Record<string, string> = { disabled: 'Replies disabled', pairing: 'Pairing in progress', active: 'Replies enabled', suspended: 'Replies suspended', 'credentials-unavailable': 'Bot credentials unavailable', conflict: 'Another cockpit owns this bot', blocked: 'Blocked — check the bot settings', stopped: 'Not running' }
const availabilityMessages: Record<string, string> = { hosted: 'Two-way Telegram is available only in a local cockpit.', flag_off: 'Two-way Telegram is turned off. Start cezar with CEZ_CHAT_INBOUND=1 to enable replies.', webhooks_off: 'Two-way Telegram needs webhooks. Start cezar with CEZ_WEBHOOKS=1 and CEZ_CHAT_INBOUND=1, then reload this page.', unavailable: 'Two-way Telegram is temporarily unavailable. Check the server status and try again.' }
const telegramErrorMessages: Record<string, string> = { flag_off: 'Two-way Telegram is turned off in this cockpit.', webhooks_off: 'Webhooks are turned off, so Telegram replies cannot run.', hosted: 'Two-way Telegram is available only in a local cockpit.', unavailable: 'Telegram is temporarily unavailable. Try again in a moment.', receiver_ineligible: 'This receiver is not ready. Test and activate it with Standard content and waiting notifications enabled.', group_ineligible: 'This group cannot receive replies. Choose a private or non-forum group chat.', group_visibility_required: 'Confirm that group members may see project messages before continuing.', chat_conflict: 'This chat is already paired with another receiver.', pairing_required: 'Pair and approve a person before enabling replies.', pairing_changed: 'The pairing changed before it was approved. Start pairing again.', chat_changed: 'The Telegram chat changed. Refresh the receiver and try again.', revision_required: 'The settings changed. Review the refreshed settings, then try again.', revision_conflict: 'Settings changed. Review the refreshed settings and try again.', receiver_changed: 'The receiver changed. Refresh it and try again.', credentials_unavailable: 'The bot token is unavailable or no longer works. Test the Telegram receiver again.', reset_unavailable: 'Access cannot be reset until the bot state can be verified.', reset_required: 'The bot state needs a reset before this action can continue.', owner_conflict: 'Another cockpit owns this bot. Stop it there or choose another bot.', foreign_state: 'This bot belongs to another project. Choose another bot.', state_missing: 'The bot state is missing. Refresh the page and try again.', bot_busy: 'The bot is busy finishing another operation. Try again shortly.', replacement_required: 'This bot is already paired. Choose Replace pairing if you want to revoke its existing access.', already_paired: 'This person is already approved for this receiver.', pairing_limit: 'Too many pairings are waiting. Cancel one and try again.', grant_limit: 'This project has reached its Telegram access limit.', comparison_required: 'Compare the code sent privately by Telegram before approving.', pairing_expired: 'This pairing link expired. Start pairing again.', binding_missing: 'This bot is no longer assigned to this receiver. Refresh the page.', grant_missing: 'This approved person no longer exists. Refresh the page.', invalid_cursor: 'The activity history cursor is no longer valid. Refresh the history.', noncanonical_root: 'Telegram inbound access cannot run until the project path is canonical.', expired: 'This pairing link expired. Start pairing again.', not_found: 'That Telegram pairing or receiver no longer exists. Refresh and try again.' }
const activityReasonLabels: Record<string, string> = { delivered: 'delivered', queued: 'queued for delivery', deferred: 'saved until the session starts', read: 'answered', preview: 'confirmation sent', executed: 'carried out', unauthorized: 'not paired', permission_denied: 'no permission for this action', rate_limited: 'too many messages', expired: 'message too old', unsupported: 'unsupported command', context_unavailable: 'project unavailable', unknown_task: 'task not found', unknown_reply: 'reply did not match a task', empty_text: 'no answer text', too_long: 'message too long', confirmation_limit: 'too many pending confirmations', configuration_unknown: 'task state does not allow this', account_unknown: 'saved account unknown', action_changed: 'task changed before confirmation', delivery_refused: 'delivery refused', delivery_uncertain: 'delivery outcome unknown', action_refused: 'action refused', action_uncertain: 'action outcome unknown', stale_reply: 'reply no longer current', not_waiting: 'task no longer waiting', grant_changed: 'access changed', interrupted: 'interrupted by a restart', pending: 'in progress', bot_not_group_member: 'bot is not in the group', candidate_not_group_member: 'person is not in the group' }
const activityKindLabels: Record<string, string> = { reply: 'Answered with /reply', answer: 'Replied to a notification', status: 'Checked status', tasks: 'Listed tasks', cancel: 'Cancel', continue: 'Continue', unknown_command: 'Unknown command' }
const activityStateLabels: Record<string, string> = { accepted: 'Done', queued: 'Queued', deferred: 'Deferred', rejected: 'Refused', uncertain: 'Outcome unknown' }
function telegramMessage(error: unknown): string { const raw = error instanceof Error ? error.message : String(error ?? ''), code = raw.toLowerCase().replace(/^telegram[_ -]?/, ''); return telegramSetupErrorMessages[code] ?? telegramErrorMessages[code] ?? (raw.includes('_') ? 'Telegram could not complete that action. Refresh and try again.' : raw || 'Telegram could not complete that action. Refresh and try again.') }
function activityReason(reason: string, state?: string): string { return activityReasonLabels[reason] ?? (state === 'accepted' || state === 'queued' || state === 'deferred' ? 'completed' : 'not completed') }
const errorCode = (error: unknown) => (error instanceof Error ? error.message : String(error ?? '')).toLowerCase().replace(/^telegram[_ -]?/, '')
function pollTime(value?: number): string { return value ? new Date(value).toLocaleString() : 'not yet' }

export type TelegramSetupApi = {
  begin: (projectId: string, receiverId: string, expectedRevision: string, mode: 'notifications' | 'task_control') => Promise<TelegramSetupBegun>
  status: (projectId: string, id: string, signal?: AbortSignal) => Promise<TelegramSetupStatus>
  activate: (projectId: string, id: string, input: { expectedRevision: string; candidateUserId: string; permissions: TelegramInboundGrant['permissions']; mode: 'notifications' | 'task_control' }) => Promise<TelegramSetupActivated>
}
const defaultSetupApi: TelegramSetupApi = {
  begin: async (projectId, receiverId, expectedRevision, mode) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup.$post({ param: { projectId }, json: { receiverId, expectedRevision, dedicatedBot: true, mode } }), '/telegram/setup'),
  status: async (projectId, id, signal) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].$get({ param: { projectId, id } }, { init: { signal } }), '/telegram/setup'),
  activate: async (projectId, id, input) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].activate.$post({ param: { projectId, id }, json: { ...input, activate: true } }), '/telegram/setup/activate'),
}

export function TelegramInboundPanel({ projectId, receivers, setupApi = defaultSetupApi }: { projectId: string; receivers: WebhookReceiver[]; setupApi?: TelegramSetupApi }) {
  const [open, setOpen] = useState(false)
  return <section className="flex flex-col gap-3 rounded-md border p-3">
    <h3 className="text-sm font-semibold"><Button variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>Two-way Telegram</Button></h3>
    {!receivers.length && !open && <p className="text-sm text-muted-foreground">Add a Telegram receiver first, then come back here to let people reply from Telegram. Existing bot access and assignment diagnostics remain available here.</p>}
    {open && <TelegramSettings key={projectId} projectId={projectId} receivers={receivers} setupApi={setupApi} />}
  </section>
}
function TelegramSettings({ projectId, receivers, setupApi }: { projectId: string; receivers: WebhookReceiver[]; setupApi: TelegramSetupApi }) {
  const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
  const client = useQueryClient(), key = telegramKey(projectId)
  const [pairing, setPairing] = useState<TelegramPairingCreated & { group: boolean }>()
  const [replaceConfirmation, setReplaceConfirmation] = useState<{ receiverId: string; group: boolean }>()
  const [groupVisibility, setGroupVisibility] = useState(false), [comparisonVerified, setComparisonVerified] = useState(false)
  useEffect(() => setComparisonVerified(false), [pairing?.pairingId])
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<{ botId: string; revision: string; disconnect: boolean; orphan?: boolean }>()
  const [revokeConfirmation, setRevokeConfirmation] = useState<{ grantId: string; revision: string; label: string }>()
  const [showBindings, setShowBindings] = useState(false)
  const [wizard, setWizard] = useState<'idle' | 'token' | 'discovering' | 'candidate' | 'permissions' | 'review' | 'activating' | 'complete' | 'recovery'>('idle')
  const [mode, setMode] = useState<'notifications' | 'task_control'>('notifications')
  const [wizardReceiver, setWizardReceiver] = useState('')
  const [setup, setSetup] = useState<TelegramSetupBegun>()
  const [setupStatus, setSetupStatus] = useState<TelegramSetupStatus>()
  const [wizardPermissions, setWizardPermissions] = useState<TelegramInboundGrant['permissions']>(['respond'])
  const [wizardError, setWizardError] = useState('')
  const wizardRequest = useRef(0)
  const candidateAction = useRef<HTMLButtonElement>(null), recoveryAction = useRef<HTMLButtonElement>(null), completeAction = useRef<HTMLButtonElement>(null)
  const bindings = useQuery({ queryKey: [...key, 'bindings'], queryFn: ({ signal }) => telegramApi.bindings(signal), enabled: showBindings, retry: false })
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => telegramApi.list(projectId, signal), retry: false })
  useTelegramSubscription(projectId, list.data?.available === true)
  const status = useQuery({ queryKey: [...key, 'pairing', pairing?.pairingId], queryFn: ({ signal }) => telegramApi.pairing(projectId, pairing!.pairingId, signal), enabled: !!pairing, retry: false })
  const setupPoll = useQuery({ queryKey: [...key, 'setup', setup?.setupId], queryFn: ({ signal }) => setupApi.status(projectId, setup!.setupId, signal), enabled: !!setup && wizard === 'discovering', retry: false, refetchInterval: 2_000 })
  const activity = useInfiniteQuery({ queryKey: [...key, 'activity'], initialPageParam: undefined as string | undefined, queryFn: ({ signal, pageParam }) => telegramApi.activity(projectId, signal, pageParam), getNextPageParam: page => page.nextCursor, enabled: list.data?.available === true, retry: false })
  useEffect(() => {
    if (!pairing) return
    const timer = setTimeout(() => { setPairing(undefined); setError('Pairing expired. Start again.') }, Math.max(0, pairing.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [pairing])
  useEffect(() => {
    if (!setupPoll.data || wizard !== 'discovering') return
    setSetupStatus(setupPoll.data)
    if (setupPoll.data.status === 'candidate') setWizard('candidate')
    else if (setupPoll.data.status === 'expired') { setSetup(undefined); setWizardError('This setup link expired. Create a new link and try again.'); setWizard('recovery') }
  }, [setupPoll.data, wizard])
  useEffect(() => { if (setupPoll.error && wizard === 'discovering') { setWizardError(telegramMessage(setupPoll.error)); setWizard('recovery') } }, [setupPoll.error, wizard])
  useEffect(() => {
    const target = wizard === 'candidate' ? candidateAction.current : wizard === 'recovery' ? recoveryAction.current : wizard === 'complete' ? completeAction.current : null
    target?.focus()
  }, [wizard])
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (cause) { if (mounted.current) setError(telegramMessage(cause)) }
    finally { await client.invalidateQueries({ queryKey: key }); if (mounted.current) setBusy(false) }
  }
  // The server's two-phase replacement answers revision_required on its normal path; retry once with the fresh revision.
  const startPairing = async (receiverId: string, group: boolean, replace: boolean) => {
    const revisionFor = async (fresh: boolean) => (fresh ? await telegramApi.list(projectId) : list.data)?.receivers.find(row => row.receiverId === receiverId)?.inboundRevision ?? ''
    const attempt = async (fresh: boolean) => telegramApi.pair(projectId, receiverId, await revisionFor(fresh), replace, group && groupVisibility)
    let next: TelegramPairingCreated
    try { next = await attempt(false) } catch (cause) {
      if (errorCode(cause) === 'replacement_required' && !replace) { if (mounted.current) setReplaceConfirmation({ receiverId, group }); return }
      if (errorCode(cause) !== 'revision_required') throw cause
      next = await attempt(true)
    }
    if (!mounted.current) return
    setPairing({ ...next, group }); setReplaceConfirmation(undefined)
    setNotice(replace ? 'Replacement pairing started. Previous approvals and reply links for this receiver were removed. Open Telegram and press Start, then approve the new person here.'
      : 'Pairing started. Open Telegram and press Start; this page will show the person when Telegram responds.')
  }
  if (list.isPending) return <p role="status">Loading Telegram settings…</p>
  if (list.error) return <div><p role="alert">{telegramMessage(list.error)}</p><Button variant="outline" onClick={() => void list.refetch()}>Retry loading settings</Button></div>
  const data = list.data!
  if (!data.available) return <p role="status" aria-live="polite">{availabilityMessages[data.reason ?? 'unavailable']}</p>
  const eligibleReceivers = data.receivers.flatMap(row => {
    const receiver = receivers.find(item => item.id === row.receiverId)
    const eligible = receiver?.state === 'active' && receiver.lastTest === 'success' && receiver.profile === 'standard'
      && (receiver.preset === 'attention' || receiver.preset === 'all' || receiver.events.includes('task.attention_required'))
      && /^[1-9][0-9]*$/.test(receiver.telegramChatId ?? '')
    return receiver && eligible ? [{ row, receiver }] : []
  })
  const resetWizard = () => { wizardRequest.current += 1; setSetup(undefined); setSetupStatus(undefined); setWizardReceiver(''); setWizardPermissions(['respond']); setWizardError(''); setWizard('idle') }
  const selectedSetupReceiver = eligibleReceivers.find(item => item.row.receiverId === wizardReceiver)
  const beginWizard = async () => {
    if (!selectedSetupReceiver) return
    const request = ++wizardRequest.current
    setWizardError(''); setWizard('discovering')
    try { const begun = await setupApi.begin(projectId, selectedSetupReceiver.row.receiverId, selectedSetupReceiver.row.inboundRevision, mode); if (request === wizardRequest.current && mounted.current) setSetup(begun) }
    catch (cause) { if (request === wizardRequest.current && mounted.current) { setWizardError(telegramMessage(cause)); setWizard('recovery') } }
  }
  const activateWizard = async () => {
    if (!setup || !setupStatus?.candidate) return
    setWizardError(''); setWizard('activating')
    try {
      await setupApi.activate(projectId, setup.setupId, { expectedRevision: setupStatus.inboundRevision, candidateUserId: setupStatus.candidate.userId, permissions: wizardPermissions, mode })
      await client.invalidateQueries({ queryKey: key }); setWizard('complete')
    } catch (cause) { setWizardError(telegramMessage(cause)); setWizard('recovery') }
  }
  return <div className="flex flex-col gap-3 text-sm">
    <section aria-labelledby="telegram-setup-title" className="flex flex-col gap-3 rounded border p-3">
      <div><h3 id="telegram-setup-title" className="font-medium">Guided Telegram setup</h3><p className="text-muted-foreground">Connect one trusted person to an active Telegram notification receiver.</p></div>
      {wizard === 'idle' && <>
        <fieldset className="flex flex-col gap-2"><legend className="font-medium">Choose what Telegram can do</legend>
          <label className="flex gap-2"><input type="radio" name="telegram-mode" checked={mode === 'notifications'} onChange={() => setMode('notifications')} /><span><strong>Notifications only</strong> — receive updates and answer questions; no task commands.</span></label>
          <label className="flex gap-2"><input type="radio" name="telegram-mode" checked={mode === 'task_control'} onChange={() => setMode('task_control')} /><span><strong>Task control</strong> — also list, cancel, and continue tasks.</span></label>
        </fieldset>
        {mode === 'task_control' && <p role="alert" className="rounded border border-warning/50 bg-warning/10 p-2">Task control can instruct an agent that runs shell commands on this machine. Continuing work may incur provider costs.</p>}
        <Button disabled={!eligibleReceivers.length} onClick={() => setWizard('token')}>Start guided setup</Button>
        {!eligibleReceivers.length && <p className="text-muted-foreground">No ready Telegram receiver. Add one below, send a passing test, activate it with Standard content and waiting notifications, then return here. Reset and orphan recovery remain available below.</p>}
      </>}
      {wizard === 'token' && <>
        <label className="flex flex-col gap-1">Telegram receiver<select aria-label="Telegram receiver" className="rounded border bg-background p-2" value={wizardReceiver} onChange={event => setWizardReceiver(event.target.value)}><option value="">Choose a receiver</option>{eligibleReceivers.map(({ row, receiver }) => <option key={row.receiverId} value={row.receiverId}>{receiver.name}</option>)}</select></label>
        <p className="text-muted-foreground">Cezar will validate the receiver’s saved bot token. Guided setup supports private chats only. The token is never shown here or kept in this setup screen.</p>
        <div className="flex gap-2"><Button variant="outline" onClick={resetWizard}>Back</Button><Button disabled={!selectedSetupReceiver} onClick={() => void beginWizard()}>Validate token and create link</Button></div>
      </>}
      {wizard === 'discovering' && <>
        <p role="status" aria-live="polite">{setup ? 'Bot token validated. Waiting for you to open Telegram and press Start…' : 'Validating the saved bot token…'}</p>
        {setup && <a className="underline" href={setup.deepLink} target="_blank" rel="noopener noreferrer">Open Telegram</a>}
        <Button variant="outline" onClick={resetWizard}>Cancel setup</Button>
      </>}
      {wizard === 'candidate' && setupStatus?.candidate && <>
        <p role="status">Found {setupStatus.candidate.label}{setupStatus.candidate.username ? ` (@${setupStatus.candidate.username})` : ''}. Confirm this is the person who opened the link.</p>
        <div className="flex gap-2"><Button variant="outline" onClick={resetWizard}>Not this person</Button><Button ref={candidateAction} onClick={() => setWizard('permissions')}>Review permissions</Button></div>
      </>}
      {wizard === 'permissions' && <>
        <fieldset className="flex flex-col gap-2"><legend className="font-medium">Least-privilege permissions</legend>
          <label className="flex gap-2"><input type="checkbox" checked disabled />Answer notifications</label>
          {mode === 'task_control' && (['cancel', 'continue'] as const).map(permission => <label className="flex gap-2" key={permission}><input type="checkbox" checked={wizardPermissions.includes(permission)} onChange={event => setWizardPermissions(current => event.target.checked ? [...current, permission] : current.filter(value => value !== permission))} />{permission === 'cancel' ? 'Cancel tasks' : 'Continue tasks (may incur costs)'}</label>)}
        </fieldset>
        <div className="flex gap-2"><Button variant="outline" onClick={() => setWizard('candidate')}>Back</Button><Button onClick={() => setWizard('review')}>Review setup</Button></div>
      </>}
      {wizard === 'review' && setupStatus?.candidate && <>
        <p><strong>{mode === 'notifications' ? 'Notifications only' : 'Task control'}</strong> for {setupStatus.candidate.label} using @{setupStatus.bot.username}.</p>
        <p>Permissions: {wizardPermissions.map(value => value === 'respond' ? 'answer notifications' : `${value} tasks`).join(', ')}.</p>
        {mode === 'task_control' && <p role="alert" className="rounded border border-warning/50 bg-warning/10 p-2">This person can control tasks whose agents may run shell commands. Continue may spend provider credits.</p>}
        <div className="flex gap-2"><Button variant="outline" onClick={() => setWizard('permissions')}>Back</Button><Button onClick={() => void activateWizard()}>Activate Telegram</Button></div>
      </>}
      {wizard === 'activating' && <p role="status" aria-live="polite">Activating Telegram…</p>}
      {wizard === 'complete' && <><p role="status" aria-live="polite" className="rounded border border-success/50 bg-success/10 p-2">Telegram is connected and listening in {mode === 'notifications' ? 'notifications-only' : 'task-control'} mode.</p><Button ref={completeAction} variant="outline" onClick={resetWizard}>Set up another person</Button></>}
      {wizard === 'recovery' && <><p role="alert" className="text-danger">{wizardError || 'Telegram setup could not continue.'}</p><p className="text-muted-foreground">Check the receiver and bot diagnostics below. You can reset damaged access or release an orphaned assignment without a receiver.</p><div className="flex gap-2"><Button ref={recoveryAction} onClick={() => { wizardRequest.current += 1; setWizardError(''); setSetup(undefined); setSetupStatus(undefined); setWizard('token') }}>Try again</Button><Button variant="outline" onClick={resetWizard}>Exit setup</Button></div></>}
    </section>
    <p>Approved people can reply to a bot notification{data.grants.some(grant => grant.capability === 'task_control') ? ' or use /tasks, /status and /reply. With separate permission, /cancel and /continue require confirmation in Telegram.' : '. Legacy approvals without a capability are treated as notifications-only.'} Plain-text questions are shown in the cockpit; Reply to the bot’s message to answer them. Access applies to all tasks in this project.</p>
    {data.grants.some(grant => grant.capability === 'task_control') && <p className="rounded border border-warning/50 bg-warning/10 p-2">Task-control access lets approved people instruct an agent that may run shell commands on this machine. Approve only people you trust. Continue may incur provider costs.</p>}
    <p>Notification delays stay unchanged. Use one dedicated bot per project. After you disconnect, another app that uses this bot may need to set up its own message delivery again.</p>
    <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={consent} onChange={event => setConsent(event.target.checked)} />This bot is dedicated to this project and is not used by another application to receive messages.</label>
    {receivers.some(receiver => receiver.telegramChatId?.startsWith('-')) && <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={groupVisibility} onChange={event => setGroupVisibility(event.target.checked)} />I understand that all group members can read project messages, including people without permission to control tasks.</label>}
    {notice && <p role="status" aria-live="polite" className="rounded border border-success/50 bg-success/10 p-2">{notice}</p>}
    {error && !confirmation && !revokeConfirmation && !replaceConfirmation && <p role="alert" className="text-danger">{error}</p>}
    {!data.receivers.length && <div className="rounded border border-dashed p-4"><p className="font-medium">No Telegram receivers yet</p><p className="text-muted-foreground">Add and successfully test a Telegram receiver below before pairing people with it.</p></div>}
    {data.receivers.map(row => {
      const receiver = receivers.find(item => item.id === row.receiverId), grants = data.grants.filter(grant => grant.receiverId === row.receiverId)
      const group = receiver?.telegramChatId?.startsWith('-') === true
      const eligible = receiver?.state === 'active' && receiver.lastTest === 'success' && receiver.profile === 'standard' && (receiver.preset === 'attention' || receiver.preset === 'all' || receiver.events.includes('task.attention_required')) && /^-?[1-9][0-9]*$/.test(receiver.telegramChatId ?? '')
      return <article aria-label={receiver?.name ?? 'Telegram receiver'} key={row.receiverId} className="flex flex-col gap-2 rounded border p-3">
        <strong>{receiver?.name ?? 'Telegram receiver'}</strong><span className="text-muted-foreground">{receiverStateLabels[row.state] ?? 'Status unavailable'}</span>{row.botId && <p>Replacing pairing revokes all approved people and reply links for this receiver. Other receivers keep their access.</p>}
        {!eligible && <p>Pairing is unavailable because this receiver must be active, tested successfully, use Standard content, send waiting notifications, and target a private or non-forum group chat.</p>}
        <div className="flex flex-wrap gap-2">
          {(!grants.length || group) && <Button title={!eligible ? 'This receiver is not ready for pairing.' : !consent ? 'Confirm that this bot is dedicated to this project.' : group && !groupVisibility ? 'Confirm that group members can see project messages.' : undefined} disabled={busy || !eligible || !consent || (group && !groupVisibility) || !!pairing} onClick={() => void act(() => startPairing(row.receiverId, group, false))}>Pair person</Button>}
          {!!row.botId && <Button variant="outline" disabled={busy || !eligible || !consent || (group && !groupVisibility) || !!pairing} onClick={() => { setError(''); setNotice(''); setReplaceConfirmation({ receiverId: row.receiverId, group }) }}>Replace pairing (revoke access)</Button>}
          {!!grants.length && <Button variant="outline" title={row.state !== 'active' && !eligible ? 'This receiver must be active, tested, and configured for waiting notifications.' : row.state !== 'active' && group && !groupVisibility ? 'Confirm group visibility before enabling replies.' : undefined} disabled={busy || (row.state !== 'active' && (!eligible || (group && !groupVisibility)))} onClick={() => void act(async () => { const enabling = row.state !== 'active'; await telegramApi.enable(projectId, row.receiverId, row.inboundRevision, enabling, group && groupVisibility); if (mounted.current) setNotice(enabling ? 'Replies enabled for this Telegram receiver.' : 'Replies disabled for this Telegram receiver.') })}>{row.state === 'active' ? 'Disable replies' : 'Enable replies'}</Button>}
        </div>
        {grants.map(grant => <div key={grant.id} className="flex flex-wrap items-center gap-2"><span>{grant.label} · Telegram ID {shortId(grant.userId)}</span>
          {grant.capability === 'task_control' && (['cancel', 'continue'] as const).map(permission => <label key={permission} className="flex items-center gap-1"><input type="checkbox" aria-label={`Allow ${permission} for Telegram ID ${grant.userId}`} checked={grant.permissions.includes(permission)} disabled={busy} onChange={event => {
            const permissions = event.target.checked ? [...grant.permissions, permission] : grant.permissions.filter(value => value !== permission)
            void act(() => telegramApi.permissions(projectId, grant.id, row.inboundRevision, permissions))
          }} />{permission === 'cancel' ? 'Cancel tasks' : 'Continue tasks (paid work)'}</label>)}<Button variant="outline" disabled={busy} onClick={() => setRevokeConfirmation({ grantId: grant.id, revision: row.inboundRevision, label: grant.label })}>Revoke access</Button></div>)}
      </article>
    })}
    {pairing && <div className="flex flex-col gap-2 rounded border p-3">
      <p>Open the bot in your private Telegram chat, then press Start. The link expires in five minutes.{pairing.group ? ' Verify the comparison code before approving access.' : ''}</p>
      <a href={pairing.deepLink} target="_blank" rel="noopener noreferrer" className="underline">Open Telegram to pair</a>
      <p role="status" aria-live="polite">{status.data?.status === 'candidate' ? 'Person ready for approval.' : status.data?.status === 'confirmed' ? 'Pairing approved.' : status.data?.status === 'expired' ? 'This pairing expired. Start again.' : 'Waiting for Telegram — press Start in the bot chat…'}</p>
      {status.error && <p role="alert">{telegramMessage(status.error)}</p>}
      {status.data?.candidate?.comparisonCode && <><p>Comparison code: <strong>{status.data.candidate.comparisonCode}</strong></p><label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={comparisonVerified} onChange={event => setComparisonVerified(event.target.checked)} />I compared this code with the code sent privately by the bot.</label></>}
      {status.data?.candidate && <><p>{status.data.candidate.label}{status.data.candidate.username ? ` (@${status.data.candidate.username})` : ''} · Telegram ID {shortId(status.data.candidate.userId)}</p><Button title={status.data.candidate.comparisonCode && !comparisonVerified ? 'Compare the code sent by Telegram before approving.' : undefined} disabled={busy || (!!status.data.candidate.comparisonCode && !comparisonVerified)} onClick={() => void act(async () => { await telegramApi.confirm(projectId, pairing.pairingId, status.data!.inboundRevision, status.data!.candidate!.userId, comparisonVerified); if (mounted.current) { setPairing(undefined); setNotice(`Access approved for ${status.data!.candidate!.label}. They can now reply to this project’s Telegram notifications.`) } })}>Approve this person</Button></>}
      <Button variant="outline" disabled={busy} onClick={() => void act(async () => { await telegramApi.cancelPairing(projectId, pairing.pairingId); if (mounted.current) setPairing(undefined) })}>Cancel pairing</Button>
    </div>}
    {data.bots.map(bot => <div key={bot.botId} className="flex flex-wrap items-center gap-2">
      <span role="status" aria-live="polite">Telegram bot {shortId(bot.botId)}: {telegramHealthLabels[bot.health.state] ?? 'Status unavailable'}{bot.health.lastSuccessfulPollAt ? ` · Last successful poll: ${pollTime(bot.health.lastSuccessfulPollAt)}` : ' · Last successful poll: not yet'}</span>{!!bot.health.droppedReplies && <span role="status">{bot.health.droppedReplies} bot replies were dropped since this bot started. Task actions are not retried.</span>}{!bot.inboundRevision && <p>State cannot be safely read. Reset is unavailable until its integrity can be checked.</p>}
      <Button variant="outline" disabled={busy || !bot.inboundRevision} onClick={() => { if (bot.inboundRevision) setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: false }) }}>Reset access</Button>
      <Button variant="outline" disabled={busy || !bot.inboundRevision} onClick={() => { if (bot.inboundRevision) setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: true }) }}>Disconnect bot</Button>
    </div>)}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !busy) setConfirmation(undefined) }}>
      <DialogContent><DialogHeader><DialogTitle>{confirmation?.orphan ? 'Release orphaned bot?' : confirmation?.disconnect ? 'Disconnect Telegram bot?' : 'Reset Telegram access?'}</DialogTitle>
        <DialogDescription>{confirmation?.orphan ? 'This releases the bot from a missing project. Old approvals cannot be restored by bringing that project back.' : 'This removes all approved people and reply links for this bot. Pair again to restore access.'} {confirmation?.disconnect ? 'The bot will also be released for another project.' : 'The bot remains assigned to this project.'}</DialogDescription>
      </DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmation(undefined)}>Keep access</Button>
        <Button disabled={busy} onClick={() => { if (confirmation) { const action = confirmation; void act(async () => {
          if (action.orphan) await telegramApi.releaseBinding(action.botId, action.revision)
          else await (action.disconnect ? telegramApi.disconnect : telegramApi.reset)(projectId, action.botId, action.revision)
          if (mounted.current) { setConfirmation(undefined); setPairing(undefined) }
        }) } }}>Confirm removal</Button></DialogFooter></DialogContent>
    </Dialog>
    <Dialog open={!!replaceConfirmation} onOpenChange={open => { if (!open && !busy) setReplaceConfirmation(undefined) }}>
      <DialogContent><DialogHeader><DialogTitle>Replace pairing?</DialogTitle>
        <DialogDescription>Starting a replacement immediately removes every approved person and reply link for this receiver. Only the person you approve next will have access.</DialogDescription>
      </DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setReplaceConfirmation(undefined)}>Keep current access</Button>
        <Button variant="danger-ghost" disabled={busy} onClick={() => { if (replaceConfirmation) { const action = replaceConfirmation; void act(() => startPairing(action.receiverId, action.group, true)) } }}>Remove access and start pairing</Button></DialogFooter></DialogContent>
    </Dialog>
    <Dialog open={!!revokeConfirmation} onOpenChange={open => { if (!open && !busy) setRevokeConfirmation(undefined) }}>
      <DialogContent><DialogHeader><DialogTitle>Revoke access for {revokeConfirmation?.label}?</DialogTitle>
        <DialogDescription>This immediately removes this person’s Telegram permissions and reply links. They must pair again to regain access.</DialogDescription>
      </DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setRevokeConfirmation(undefined)}>Keep access</Button>
        <Button variant="danger-ghost" disabled={busy} onClick={() => { if (revokeConfirmation) { const action = revokeConfirmation; void act(async () => { await telegramApi.revoke(projectId, action.grantId, action.revision); if (mounted.current) setRevokeConfirmation(undefined) }) } }}>Revoke access</Button></DialogFooter></DialogContent>
    </Dialog>
    <Button variant="outline" aria-expanded={showBindings} onClick={() => setShowBindings(value => !value)}>Bot assignment diagnostics</Button>
    {showBindings && <div className="flex flex-col gap-2">
      {bindings.isPending && <p role="status">Loading assignments…</p>}
      {bindings.error && <p role="alert">{telegramMessage(bindings.error)}</p>}
      {bindings.data?.truncated && <p role="alert">Some assignments could not be listed. This view is incomplete.</p>}
      {bindings.data?.bindings.map(binding => <div key={binding.botId} className="flex flex-wrap items-center gap-2">
        <span>Telegram bot {shortId(binding.botId)} · project {binding.projectName ?? binding.projectId} · {binding.orphaned ? 'project unavailable' : 'assigned'}</span>
        {binding.orphaned && <Button variant="outline" disabled={busy} onClick={() => setConfirmation({ botId: binding.botId, revision: binding.inboundRevision, disconnect: true, orphan: true })}>Release orphaned bot</Button>}
      </div>)}
    </div>}
    <Button variant="ghost" disabled={busy} onClick={() => void client.invalidateQueries({ queryKey: key })}>Refresh status</Button>
    <div><h4 className="font-medium">Recent Telegram actions</h4>{activity.error && <p role="alert">{telegramMessage(activity.error)}</p>}
      {activity.data?.pages.flatMap(page => page.entries).map(entry => <p key={entry.id} className={entry.state === 'uncertain' ? 'text-warning' : ''}>{new Date(entry.at).toLocaleString()} · {entry.kind === 'rejection_summary' ? `Bot-wide · ${entry.count} rejected messages · ${activityReason(entry.reason)}` : [
        data.grants.find(grant => grant.userId === entry.userId && (!entry.chatId || grant.chatId === entry.chatId))?.label ?? `Telegram ID ${shortId(entry.userId ?? '')}`,
        activityKindLabels[entry.kind] ?? 'Unknown command', ...(entry.runId ? [`task ${entry.runId.slice(0, 8)}`] : []),
        `${activityStateLabels[entry.state] ?? 'Outcome unknown'}: ${activityReason(entry.reason, entry.state)}`].join(' · ')}</p>)}
      {activity.hasNextPage && <Button variant="outline" disabled={activity.isFetchingNextPage} onClick={() => void activity.fetchNextPage()}>Load older actions</Button>}
      {activity.data?.pages[0]?.entries.length === 0 && <p>No recorded actions.</p>}
    </div>
  </div>
}
