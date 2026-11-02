import { useEffect, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import type { TelegramInboundGrant, TelegramSetupActivate, TelegramSetupActivated, TelegramSetupBegin, TelegramSetupBegun, TelegramSetupStatus, WebhookReceiver } from '@open-mercato/cezar-api-client'
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
}

const telegramHealthLabels: Record<string, string> = { stopped: 'Not running', polling: 'Connected and listening', backoff: 'Temporarily retrying', blocked: 'Blocked — check the bot settings', conflict: 'Another cockpit owns this bot', 'credentials-unavailable': 'Bot credentials unavailable' }
const receiverStateLabels: Record<string, string> = { disabled: 'Replies disabled', pairing: 'Pairing in progress', active: 'Replies enabled', suspended: 'Replies suspended', 'credentials-unavailable': 'Bot credentials unavailable', conflict: 'Another cockpit owns this bot', blocked: 'Blocked — check the bot settings', stopped: 'Not running' }
const availabilityMessages: Record<string, string> = { hosted: 'Two-way Telegram is available only in a local cockpit.', flag_off: 'Two-way Telegram is turned off. Start cezar with CEZ_CHAT_INBOUND=1 to enable replies.', webhooks_off: 'Two-way Telegram needs webhooks. Start cezar with CEZ_WEBHOOKS=1 and CEZ_CHAT_INBOUND=1, then reload this page.', unavailable: 'Two-way Telegram is temporarily unavailable. Check the server status and try again.' }
const telegramErrorMessages: Record<string, string> = { flag_off: 'Two-way Telegram is turned off in this cockpit.', webhooks_off: 'Webhooks are turned off, so Telegram replies cannot run.', hosted: 'Two-way Telegram is available only in a local cockpit.', unavailable: 'Telegram is temporarily unavailable. Try again in a moment.', receiver_ineligible: 'This receiver is not ready. Test and activate it with Standard content and waiting notifications enabled.', group_ineligible: 'This group cannot receive replies. Choose a private or non-forum group chat.', group_visibility_required: 'Confirm that group members may see project messages before continuing.', chat_conflict: 'This chat is already paired with another receiver.', pairing_required: 'Run guided setup to approve a person before enabling replies.', pairing_changed: 'The pairing changed before it was approved. Start pairing again.', chat_changed: 'The Telegram chat changed. Refresh the receiver and try again.', revision_required: 'The settings changed. Review the refreshed settings, then try again.', revision_conflict: 'Settings changed. Review the refreshed settings and try again.', receiver_changed: 'The receiver changed. Refresh it and try again.', credentials_unavailable: 'The bot token is unavailable or no longer works. Test the Telegram receiver again.', reset_unavailable: 'Access cannot be reset until the bot state can be verified.', reset_required: 'The bot state needs a reset before this action can continue.', owner_conflict: 'Another cockpit owns this bot. Stop it there or choose another bot.', foreign_state: 'This bot belongs to another project. Choose another bot.', state_missing: 'The bot state is missing. Refresh the page and try again.', bot_busy: 'The bot is busy finishing another operation. Try again shortly.', replacement_required: 'This receiver’s bot or chat changed. Replace the pairing to continue.', already_paired: 'This person is already approved for this receiver.', pairing_limit: 'Too many setup links are waiting. Wait five minutes or cancel one, then try again.', grant_limit: 'This project has reached its Telegram access limit.', comparison_required: 'Compare the code sent privately by Telegram before approving.', pairing_expired: 'This setup link expired. Create a new link and try again.', binding_missing: 'This bot is no longer assigned to this receiver. Refresh the page.', grant_missing: 'This approved person no longer exists. Refresh the page.', invalid_cursor: 'The activity history cursor is no longer valid. Refresh the history.', noncanonical_root: 'Telegram inbound access cannot run until the project path is canonical.', expired: 'This setup link expired. Create a new link and try again.', not_found: 'That Telegram pairing or receiver no longer exists. Refresh and try again.' }
const activityReasonLabels: Record<string, string> = { delivered: 'delivered', queued: 'queued for delivery', deferred: 'saved until the session starts', read: 'answered', preview: 'confirmation sent', executed: 'carried out', unauthorized: 'not paired', permission_denied: 'no permission for this action', rate_limited: 'too many messages', expired: 'message too old', unsupported: 'unsupported command', context_unavailable: 'project unavailable', unknown_task: 'task not found', unknown_reply: 'reply did not match a task', empty_text: 'no answer text', too_long: 'message too long', confirmation_limit: 'too many pending confirmations', configuration_unknown: 'task state does not allow this', account_unknown: 'saved account unknown', action_changed: 'task changed before confirmation', delivery_refused: 'delivery refused', delivery_uncertain: 'delivery outcome unknown', action_refused: 'action refused', action_uncertain: 'action outcome unknown', stale_reply: 'reply no longer current', not_waiting: 'task no longer waiting', grant_changed: 'access changed', interrupted: 'interrupted by a restart', pending: 'in progress', bot_not_group_member: 'bot is not in the group', candidate_not_group_member: 'person is not in the group', task_created: 'task started', declined: 'cancelled before starting', provider_unavailable: 'provider unavailable', account_unavailable: 'saved account unavailable', project_unavailable: 'project unavailable', creation_failed: 'task could not be created' }
const activityKindLabels: Record<string, string> = { reply: 'Answered with /reply', answer: 'Replied to a notification', status: 'Checked status', tasks: 'Listed tasks', task: 'Task request', help: 'Asked for help', cancel: 'Cancel', continue: 'Continue', unknown_command: 'Unknown command' }
const activityStateLabels: Record<string, string> = { accepted: 'Done', queued: 'Queued', deferred: 'Deferred', rejected: 'Refused', uncertain: 'Outcome unknown' }
function telegramMessage(error: unknown): string { const raw = error instanceof Error ? error.message : String(error ?? ''), code = raw.toLowerCase().replace(/^telegram[_ -]?/, ''); return telegramSetupErrorMessages[code] ?? telegramErrorMessages[code] ?? (raw.includes('_') ? 'Telegram could not complete that action. Refresh and try again.' : raw || 'Telegram could not complete that action. Refresh and try again.') }
function activityReason(reason: string, state?: string): string { return activityReasonLabels[reason] ?? (state === 'accepted' || state === 'queued' || state === 'deferred' ? 'completed' : 'not completed') }
const errorCode = (error: unknown) => (error instanceof Error ? error.message : String(error ?? '')).toLowerCase().replace(/^telegram[_ -]?/, '')
function pollTime(value?: number): string { return value ? new Date(value).toLocaleString() : 'not yet' }

export type TelegramSetupApi = {
  begin: (projectId: string, input: TelegramSetupBegin) => Promise<TelegramSetupBegun>
  status: (projectId: string, id: string, signal?: AbortSignal) => Promise<TelegramSetupStatus>
  activate: (projectId: string, id: string, input: Omit<TelegramSetupActivate, 'activate'>) => Promise<TelegramSetupActivated>
  /** An abandoned setup must free its pairing slot (three pending sessions is the server limit). */
  cancel: (projectId: string, id: string) => Promise<unknown>
}
export const defaultSetupApi: TelegramSetupApi = {
  begin: async (projectId, json) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup.$post({ param: { projectId }, json }), '/telegram/setup'),
  status: async (projectId, id, signal) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].$get({ param: { projectId, id } }, { init: { signal } }), '/telegram/setup'),
  activate: async (projectId, id, input) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].activate.$post({ param: { projectId, id }, json: { ...input, activate: true } }), '/telegram/setup/activate'),
  cancel: async (projectId, id) => unwrap(await cez.api.v1.p[':projectId'].telegram.setup[':id'].$delete({ param: { projectId, id } }), '/telegram/setup'),
}

const addReceiverHelp = 'Add a Telegram receiver first: choose Add receiver at the top of this page, pick Telegram, paste the bot token from @BotFather, use Connect chat, set Message content to Standard, save, send a test, then Activate it. Then come back here.'
const isGroup = (receiver?: WebhookReceiver) => receiver?.telegramChatId?.startsWith('-') === true
/** Only what blocks task control on this receiver, each with its fix (mirrors the server's receiverEligible). */
export function setupBlockers(receiver: WebhookReceiver): string[] {
  return [
    ...(receiver.state !== 'active' && receiver.state !== 'suspended' ? ['Activate it under Webhooks above (send a test first).'] : []),
    ...(receiver.lastTest !== 'success' ? ['Send a test and make sure it arrives.'] : []),
    ...(receiver.profile !== 'standard' ? ['Edit it and set Message content to Standard.'] : []),
    ...(receiver.preset !== 'attention' && receiver.preset !== 'all' && !receiver.events.includes('task.attention_required') ? ['Edit it and include the Needs your input event.'] : []),
    ...(!/^-?[1-9][0-9]*$/.test(receiver.telegramChatId ?? '') ? ['Edit it and use Connect chat to fill in the chat ID.'] : []),
  ]
}

export function TelegramInboundPanel({ projectId, receivers, setupApi = defaultSetupApi }: { projectId: string; receivers: WebhookReceiver[]; setupApi?: TelegramSetupApi }) {
  const [open, setOpen] = useState(false)
  // Read once while collapsed so a turned-off flag is visible without opening the panel.
  const list = useQuery({ queryKey: telegramKey(projectId), queryFn: ({ signal }) => telegramApi.list(projectId, signal), retry: false })
  const reason = list.data && !list.data.available ? list.data.reason ?? 'unavailable' : undefined
  return <section className="flex flex-col gap-3 rounded-md border p-3">
    <h3 className="text-sm font-semibold"><Button variant="outline" aria-expanded={open} onClick={() => setOpen(value => !value)}>Two-way Telegram</Button></h3>
    {!open && reason && <p role="status" className="text-sm text-muted-foreground">{availabilityMessages[reason]}</p>}
    {!open && !reason && !receivers.length && <p className="text-sm text-muted-foreground">{addReceiverHelp} Existing bot access and assignment diagnostics remain available here.</p>}
    {open && <TelegramSettings key={projectId} projectId={projectId} receivers={receivers} setupApi={setupApi} />}
  </section>
}
const taskControlRisk = 'Task control lets a person start tasks and instruct agents that run shell commands on this machine. Starting or continuing work may incur provider costs.'
type WizardStep = 'choose' | 'waiting' | 'confirm' | 'replace' | 'activating' | 'complete' | 'recovery'
function TelegramSettings({ projectId, receivers, setupApi }: { projectId: string; receivers: WebhookReceiver[]; setupApi: TelegramSetupApi }) {
  const shortId = (id: string) => id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id
  const client = useQueryClient(), key = telegramKey(projectId)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState<{ botId: string; revision: string; disconnect: boolean; orphan?: boolean }>()
  const [revokeConfirmation, setRevokeConfirmation] = useState<{ grantId: string; revision: string; label: string }>()
  const [enableVisibility, setEnableVisibility] = useState<Record<string, boolean>>({})
  const [showBindings, setShowBindings] = useState(false)
  const [wizard, setWizard] = useState<WizardStep>('choose')
  const [wizardReceiver, setWizardReceiver] = useState('')
  const [dedicatedBot, setDedicatedBot] = useState(false), [groupVisibility, setGroupVisibility] = useState(false), [comparisonVerified, setComparisonVerified] = useState(false)
  const [setup, setSetup] = useState<TelegramSetupBegun>()
  // Unmounting mid-setup (collapsing the panel, leaving the page) cancels the session too.
  const openSetup = useRef<string | undefined>(undefined)
  openSetup.current = setup?.setupId
  useEffect(() => () => { if (openSetup.current) void setupApi.cancel(projectId, openSetup.current).catch(() => undefined) }, [projectId, setupApi])
  const [setupStatus, setSetupStatus] = useState<TelegramSetupStatus>()
  const [approved, setApproved] = useState<{ label: string; group: boolean }>()
  const [wizardPermissions, setWizardPermissions] = useState<TelegramInboundGrant['permissions']>(['respond'])
  const [wizardError, setWizardError] = useState('')
  const wizardRequest = useRef(0)
  const recoveryAction = useRef<HTMLButtonElement>(null), completeAction = useRef<HTMLButtonElement>(null), replaceAction = useRef<HTMLButtonElement>(null)
  const waitingTarget = useRef<HTMLHeadingElement>(null), confirmTarget = useRef<HTMLHeadingElement>(null), activatingTarget = useRef<HTMLHeadingElement>(null)
  const bindings = useQuery({ queryKey: [...key, 'bindings'], queryFn: ({ signal }) => telegramApi.bindings(signal), enabled: showBindings, retry: false })
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const list = useQuery({ queryKey: key, queryFn: ({ signal }) => telegramApi.list(projectId, signal), retry: false })
  useTelegramSubscription(projectId, list.data?.available === true)
  const setupPoll = useQuery({ queryKey: [...key, 'setup', setup?.setupId], queryFn: ({ signal }) => setupApi.status(projectId, setup!.setupId, signal), enabled: !!setup && wizard === 'waiting', retry: false, refetchInterval: 2_000 })
  const activity = useInfiniteQuery({ queryKey: [...key, 'activity'], initialPageParam: undefined as string | undefined, queryFn: ({ signal, pageParam }) => telegramApi.activity(projectId, signal, pageParam), getNextPageParam: page => page.nextCursor, enabled: list.data?.available === true, retry: false })
  useEffect(() => {
    if (!setupPoll.data || wizard !== 'waiting') return
    setSetupStatus(setupPoll.data)
    if (setupPoll.data.status === 'candidate') setWizard('confirm')
    else if (setupPoll.data.status === 'expired') { setSetup(undefined); setWizardError('This setup link expired. Create a new link and try again.'); setWizard('recovery') }
  }, [setupPoll.data, wizard])
  useEffect(() => { if (setupPoll.error && wizard === 'waiting') { setWizardError(telegramMessage(setupPoll.error)); setWizard('recovery') } }, [setupPoll.error, wizard])
  useEffect(() => {
    const target = { waiting: waitingTarget, confirm: confirmTarget, activating: activatingTarget, recovery: recoveryAction, complete: completeAction, replace: replaceAction, choose: undefined }[wizard]?.current
    target?.focus()
  }, [wizard])
  const act = async (work: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (cause) { if (mounted.current) setError(telegramMessage(cause)) }
    finally { await client.invalidateQueries({ queryKey: key }); if (mounted.current) setBusy(false) }
  }
  if (list.isPending) return <p role="status">Loading Telegram settings…</p>
  if (list.error) return <div><p role="alert">{telegramMessage(list.error)}</p><Button variant="outline" onClick={() => void list.refetch()}>Retry loading settings</Button></div>
  const data = list.data!
  if (!data.available) return <p role="status" aria-live="polite">{availabilityMessages[data.reason ?? 'unavailable']}</p>
  const knownReceivers = data.receivers.flatMap(row => { const receiver = receivers.find(item => item.id === row.receiverId); return receiver ? [{ row, receiver }] : [] })
  // A private receiver binds exactly one person (its chat owner); a group can pair each member in turn.
  // A suspended private receiver whose person can no longer be re-enabled is paired again through replacement.
  const stalePairing = (row: { receiverId: string; state: string }, receiver: WebhookReceiver) => !isGroup(receiver) && row.state === 'suspended' && data.grants.some(grant => grant.receiverId === receiver.id)
  const setupReceivers = knownReceivers.filter(({ row, receiver }) => !setupBlockers(receiver).length && (isGroup(receiver) || stalePairing(row, receiver) || !data.grants.some(grant => grant.receiverId === receiver.id)))
  const selected = setupReceivers.find(item => item.row.receiverId === wizardReceiver) ?? (setupReceivers.length === 1 ? setupReceivers[0] : undefined)
  const group = isGroup(selected?.receiver)
  const resetWizard = () => {
    wizardRequest.current += 1
    if (setup) void setupApi.cancel(projectId, setup.setupId).catch(() => undefined)
    setSetup(undefined); setSetupStatus(undefined); setApproved(undefined); setWizardReceiver(''); setDedicatedBot(false); setGroupVisibility(false); setComparisonVerified(false); setWizardPermissions(['respond']); setWizardError(''); setWizard('choose')
  }
  const beginWizard = async (replaceExisting = false) => {
    if (!selected || !dedicatedBot || (group && !groupVisibility)) return
    const request = ++wizardRequest.current, { receiverId, inboundRevision: expectedRevision } = selected.row
    setWizardReceiver(receiverId); setWizardError(''); setWizard('waiting')
    const begin = (revision: string) => setupApi.begin(projectId, { receiverId, expectedRevision: revision, dedicatedBot: true,
      ...(replaceExisting ? { replaceExisting: true as const } : {}), ...(group ? { groupVisibilityAccepted: true as const } : {}) })
    try {
      let begun: TelegramSetupBegun
      // A shared bot or a replacement answers conflict on its normal path; retry once with the fresh revision (G4).
      try { begun = await begin(expectedRevision) } catch (cause) {
        if (errorCode(cause) !== 'conflict' || request !== wizardRequest.current || !mounted.current) throw cause
        const fresh = (await telegramApi.list(projectId)).receivers.find(row => row.receiverId === receiverId)?.inboundRevision ?? ''
        if (request !== wizardRequest.current || !mounted.current) return
        begun = await begin(fresh)
      }
      if (request !== wizardRequest.current || !mounted.current) { void setupApi.cancel(projectId, begun.setupId).catch(() => undefined); return }
      setSetup(begun)
    } catch (cause) {
      if (request !== wizardRequest.current || !mounted.current) return
      if (errorCode(cause) === 'replacement_required' && !replaceExisting) { setWizard('replace'); return }
      setWizardError(telegramMessage(cause)); setWizard('recovery')
    }
  }
  const activateWizard = async () => {
    const candidate = setupStatus?.candidate
    if (!setup || !candidate || (candidate.comparisonCode && !comparisonVerified)) return
    setWizardError(''); setWizard('activating')
    try {
      await setupApi.activate(projectId, setup.setupId, { expectedRevision: setupStatus.inboundRevision, candidateUserId: candidate.userId, permissions: wizardPermissions, ...(candidate.comparisonCode ? { comparisonVerified: true as const } : {}) })
      // Activation consumed the session; nothing is left to cancel.
      setSetup(undefined); setApproved({ label: candidate.label, group: !!candidate.comparisonCode }); await client.invalidateQueries({ queryKey: key }); setWizard('complete')
    } catch (cause) { setWizardError(telegramMessage(cause)); setWizard('recovery') }
  }
  const candidate = setupStatus?.candidate
  return <div className="flex flex-col gap-3 text-sm">
    <section aria-labelledby="telegram-setup-title" className="flex flex-col gap-3 rounded border p-3">
      <div><h3 id="telegram-setup-title" className="font-medium">Guided Telegram setup</h3><p className="text-muted-foreground">Approve one trusted person for task control. Notifications need no setup: every active Telegram receiver already sends them.</p></div>
      {wizard === 'choose' && <>
        {!setupReceivers.length ? <p className="text-muted-foreground">{!knownReceivers.length ? addReceiverHelp : 'No receiver is ready for task control. Each receiver below lists what it still needs.'} Reset and orphan recovery remain available below.</p> : <>
          <label className="flex flex-col gap-1">Telegram receiver<select aria-label="Telegram receiver" className="rounded border bg-background p-2 outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50" value={selected?.row.receiverId ?? ''} onChange={event => { setWizardReceiver(event.target.value); setGroupVisibility(false) }}><option value="">Choose a receiver</option>{setupReceivers.map(({ row, receiver }) => <option key={row.receiverId} value={row.receiverId}>{receiver.name}{isGroup(receiver) ? ' (group)' : ''}</option>)}</select></label>
          {group && <>
            <p className="rounded border border-warning/50 bg-warning/10 p-2">Every member of this group can read project messages. Approved members can answer questions and use /tasks, /status and /reply there; new tasks start only from a private-chat receiver. Forum groups are not supported.</p>
            <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={groupVisibility} onChange={event => setGroupVisibility(event.target.checked)} />I understand that all group members can read project messages, including people without permission to control tasks.</label>
          </>}
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={dedicatedBot} onChange={event => setDedicatedBot(event.target.checked)} />This bot is dedicated to this project: no other application receives its messages.</label>
          <p className="text-muted-foreground">Cezar checks the receiver’s saved bot token and creates a one-time link that expires in five minutes. The token is never shown here.</p>
          <div><Button disabled={!selected || !dedicatedBot || (group && !groupVisibility)} onClick={() => { if (selected && stalePairing(selected.row, selected.receiver)) setWizard('replace'); else void beginWizard() }}>Create Telegram link</Button></div>
        </>}
      </>}
      {wizard === 'waiting' && <>
        <h4 ref={waitingTarget} tabIndex={-1} className="font-medium">Open Telegram and press Start</h4>
        <p role="status" aria-live="polite">{setup ? `Waiting for Telegram… ${group ? 'The person to approve opens this link in their own private chat with' : 'Open this link in your private chat with'} @${setup.bot.username} and presses Start.` : 'Checking the saved bot token…'}</p>
        {setup && <a className="underline" href={setup.deepLink} target="_blank" rel="noopener noreferrer">Open Telegram</a>}
        <div><Button variant="outline" onClick={resetWizard}>Cancel setup</Button></div>
      </>}
      {wizard === 'replace' && <>
        <p role="alert">{selected && stalePairing(selected.row, selected.receiver) ? 'This receiver changed since its person was approved.' : 'This receiver’s bot or chat changed.'} Replacing the pairing removes every approved person and reply link for this receiver; other receivers keep their access.</p>
        <div className="flex gap-2"><Button variant="outline" onClick={resetWizard}>Keep current access</Button><Button ref={replaceAction} variant="danger-ghost" onClick={() => void beginWizard(true)}>Replace pairing and create link</Button></div>
      </>}
      {wizard === 'confirm' && setupStatus && candidate && <>
        <h4 ref={confirmTarget} tabIndex={-1} className="font-medium">Confirm task control</h4>
        <p role="status"><strong>{candidate.label || 'Telegram user'}</strong>{candidate.username ? ` (@${candidate.username})` : ''} · Telegram ID {shortId(candidate.userId)} pressed Start in @{setupStatus.bot.username}.</p>
        {candidate.comparisonCode && <><p>Comparison code: <strong>{candidate.comparisonCode}</strong></p>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={comparisonVerified} onChange={event => setComparisonVerified(event.target.checked)} />I compared this code with the code the bot sent to this person privately.</label></>}
        <fieldset className="flex flex-col gap-2"><legend className="font-medium">Permissions</legend>
          <p className="text-muted-foreground">Always allowed: answer questions, start tasks and check task status.</p>
          {(['cancel', 'continue'] as const).map(permission => <label className="flex gap-2" key={permission}><input type="checkbox" checked={wizardPermissions.includes(permission)} onChange={event => setWizardPermissions(current => event.target.checked ? [...current, permission] : current.filter(value => value !== permission))} />{permission === 'cancel' ? 'Cancel tasks' : 'Continue tasks (may incur costs)'}</label>)}
        </fieldset>
        <p role="alert" className="rounded border border-warning/50 bg-warning/10 p-2">{taskControlRisk}</p>
        <div className="flex gap-2"><Button variant="outline" onClick={resetWizard}>Not this person</Button><Button disabled={!!candidate.comparisonCode && !comparisonVerified} onClick={() => void activateWizard()}>Activate task control</Button></div>
      </>}
      {wizard === 'activating' && <><h4 ref={activatingTarget} tabIndex={-1} className="font-medium">Activating task control</h4><p role="status" aria-live="polite">Activating task control…</p></>}
      {wizard === 'complete' && <>
        <p role="status" aria-live="polite" className="rounded border border-success/50 bg-success/10 p-2">{approved?.group
          ? `Task control is active for ${approved.label} in this group. They can answer questions and use /tasks, /status and /reply there; new tasks start only from a private-chat receiver.`
          : `Task control is active for ${approved?.label ?? 'this person'}. They can answer questions and start tasks from their private Telegram chat.`}</p>
        <p className="text-muted-foreground">{approved?.group
          ? 'Another member of this group can be approved by running this setup again.'
          : 'A private-chat receiver serves exactly one person. To add someone else, add another Telegram receiver for their private chat: paste the same bot token (cezar never shows the saved one), use Connect chat from their Telegram account, set Message content to Standard, test and activate it, then run this setup again.'}</p>
        <div><Button ref={completeAction} variant="outline" onClick={resetWizard}>Done</Button></div>
      </>}
      {wizard === 'recovery' && <><p role="alert" className="text-danger">{wizardError || 'Telegram setup could not continue.'}</p><p className="text-muted-foreground">Check the receiver and bot diagnostics below. You can reset damaged access or release an orphaned assignment without a receiver.</p><div className="flex gap-2"><Button ref={recoveryAction} onClick={async () => { const keep = { receiver: wizardReceiver, dedicated: dedicatedBot, visibility: groupVisibility }; await client.invalidateQueries({ queryKey: key }); if (!mounted.current) return; resetWizard(); setWizardReceiver(keep.receiver); setDedicatedBot(keep.dedicated); setGroupVisibility(keep.visibility) }}>Try again</Button><Button variant="outline" onClick={resetWizard}>Exit setup</Button></div></>}
    </section>
    <p>Approved people can answer questions, start tasks (private chat only), and use /tasks, /status and /reply. With separate permission, /cancel and /continue require confirmation in Telegram. Access applies to all tasks in this project. Use one dedicated bot per project; after you disconnect it, another app that uses this bot may need to set up its own message delivery again.</p>
    {!!data.grants.length && <p className="rounded border border-warning/50 bg-warning/10 p-2">Task-control access lets approved people instruct an agent that may run shell commands on this machine. Approve only people you trust. Continue may incur provider costs.</p>}
    {notice && <p role="status" aria-live="polite" className="rounded border border-success/50 bg-success/10 p-2">{notice}</p>}
    {error && !confirmation && !revokeConfirmation && <p role="alert" className="text-danger">{error}</p>}
    {!data.receivers.length && <div className="rounded border border-dashed p-4"><p className="font-medium">No Telegram receivers yet</p><p className="text-muted-foreground">{addReceiverHelp}</p></div>}
    {data.receivers.map(row => {
      const receiver = receivers.find(item => item.id === row.receiverId), grants = data.grants.filter(grant => grant.receiverId === row.receiverId)
      const blockers = receiver ? setupBlockers(receiver) : [], groupChat = isGroup(receiver), enabling = row.state !== 'active'
      const visibility = !groupChat || enableVisibility[row.receiverId] === true
      return <article aria-label={receiver?.name ?? 'Telegram receiver'} key={row.receiverId} className="flex flex-col gap-2 rounded border p-3">
        <strong>{receiver?.name ?? 'Telegram receiver'}</strong><span className="text-muted-foreground">{receiverStateLabels[row.state] ?? 'Status unavailable'}</span>
        {!!blockers.length && <div><p>Before task control can work, fix this receiver:</p><ul className="list-disc pl-5">{blockers.map(blocker => <li key={blocker}>{blocker}</li>)}</ul></div>}
        {row.state === 'suspended' && !!grants.length && <p>Replies are suspended because this receiver changed. Send a test and Activate it under Webhooks above, then choose Enable replies. If Enable replies is refused, pair the person again with guided setup above.</p>}
        {!!grants.length && <div className="flex flex-wrap items-center gap-2">
          {groupChat && enabling && <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={visibility} onChange={event => setEnableVisibility(current => ({ ...current, [row.receiverId]: event.target.checked }))} />I understand that all group members can read project messages.</label>}
          <Button variant="outline" disabled={busy || (enabling && (!!blockers.length || !visibility))} onClick={() => void act(async () => { await telegramApi.enable(projectId, row.receiverId, row.inboundRevision, enabling, enabling && groupChat); if (mounted.current) setNotice(enabling ? 'Replies enabled for this Telegram receiver.' : 'Replies disabled for this Telegram receiver.') })}>{enabling ? 'Enable replies' : 'Disable replies'}</Button>
        </div>}
        {grants.map(grant => <div key={grant.id} className="flex flex-wrap items-center gap-2"><span>{grant.label} · Telegram ID {shortId(grant.userId)}</span>
          {(['cancel', 'continue'] as const).map(permission => <label key={permission} className="flex items-center gap-1"><input type="checkbox" aria-label={`Allow ${permission} for Telegram ID ${grant.userId}`} checked={grant.permissions.includes(permission)} disabled={busy} onChange={event => {
            const permissions = event.target.checked ? [...grant.permissions, permission] : grant.permissions.filter(value => value !== permission)
            void act(() => telegramApi.permissions(projectId, grant.id, row.inboundRevision, permissions))
          }} />{permission === 'cancel' ? 'Cancel tasks' : 'Continue tasks (may incur costs)'}</label>)}<Button variant="outline" disabled={busy} onClick={() => setRevokeConfirmation({ grantId: grant.id, revision: row.inboundRevision, label: grant.label })}>Revoke access</Button></div>)}
      </article>
    })}
    {data.bots.map(bot => <div key={bot.botId} className="flex flex-wrap items-center gap-2">
      <span role="status" aria-live="polite">Telegram bot {shortId(bot.botId)}: {telegramHealthLabels[bot.health.state] ?? 'Status unavailable'}{bot.health.lastSuccessfulPollAt ? ` · Last successful poll: ${pollTime(bot.health.lastSuccessfulPollAt)}` : ' · Last successful poll: not yet'}</span>{!!bot.health.droppedReplies && <span role="status">{bot.health.droppedReplies} bot replies were dropped since this bot started. Task actions are not retried.</span>}{!bot.inboundRevision && <p>State cannot be safely read. Reset is unavailable until its integrity can be checked.</p>}
      <Button variant="outline" disabled={busy || !bot.inboundRevision} onClick={() => { if (bot.inboundRevision) setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: false }) }}>Reset access</Button>
      <Button variant="outline" disabled={busy || !bot.inboundRevision} onClick={() => { if (bot.inboundRevision) setConfirmation({ botId: bot.botId, revision: bot.inboundRevision, disconnect: true }) }}>Disconnect bot</Button>
    </div>)}
    <Dialog open={!!confirmation} onOpenChange={open => { if (!open && !busy) setConfirmation(undefined) }}>
      <DialogContent><DialogHeader><DialogTitle>{confirmation?.orphan ? 'Release orphaned bot?' : confirmation?.disconnect ? 'Disconnect Telegram bot?' : 'Reset Telegram access?'}</DialogTitle>
        <DialogDescription>{confirmation?.orphan ? 'This releases the bot from a missing project. Old approvals cannot be restored by bringing that project back.' : 'This removes all approved people and reply links for this bot. Run guided setup again to restore access.'} {confirmation?.disconnect ? 'The bot will also be released for another project.' : 'The bot remains assigned to this project.'}</DialogDescription>
      </DialogHeader>{error && <p role="alert" className="text-danger">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirmation(undefined)}>Keep access</Button>
        <Button disabled={busy} onClick={() => { if (confirmation) { const action = confirmation; void act(async () => {
          if (action.orphan) await telegramApi.releaseBinding(action.botId, action.revision)
          else await (action.disconnect ? telegramApi.disconnect : telegramApi.reset)(projectId, action.botId, action.revision)
          if (mounted.current) setConfirmation(undefined)
        }) } }}>Confirm removal</Button></DialogFooter></DialogContent>
    </Dialog>
    <Dialog open={!!revokeConfirmation} onOpenChange={open => { if (!open && !busy) setRevokeConfirmation(undefined) }}>
      <DialogContent><DialogHeader><DialogTitle>Revoke access for {revokeConfirmation?.label}?</DialogTitle>
        <DialogDescription>This immediately removes this person’s Telegram permissions and reply links. They need guided setup again to regain access.</DialogDescription>
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
