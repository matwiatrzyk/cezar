import { useEffect, useMemo, useState } from 'react'
import type { TelegramInboundGrant, TelegramSetupBegin, TelegramSetupStatus } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { defaultSetupApi, type TelegramSetupApi } from './telegram-inbound'

type Step = 'token' | 'connect' | 'activate' | 'control' | 'done'
const risk = 'Task control lets a person start tasks and instruct agents that run shell commands on this machine. Starting or continuing work may incur provider costs.'
type SetupCandidate = NonNullable<TelegramSetupStatus['candidate']> & { chatType: 'private' | 'group' }

/** One token-led setup for a Telegram receiver, notifications, and optional task control. */
export function TelegramWizard({ projectId, open, onOpenChange, onComplete, setupApi }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; onComplete?: () => void; setupApi?: TelegramSetupApi }) {
  const [step, setStep] = useState<Step>('token')
  const [name, setName] = useState('Telegram notifications')
  const [token, setToken] = useState('')
  const [dedicated, setDedicated] = useState(false)
  const [visibility, setVisibility] = useState(false)
  const [comparisonVerified, setComparisonVerified] = useState(false)
  const [taskControl, setTaskControl] = useState(false)
  const [permissions, setPermissions] = useState<TelegramInboundGrant['permissions']>(['respond'])
  const [setup, setSetup] = useState<{ setupId: string; receiverId: string; revision: string; deepLink: string }>()
  const [status, setStatus] = useState<TelegramSetupStatus>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const api = setupApi ?? defaultSetupApi
  const candidate = status?.candidate as SetupCandidate | undefined
  const group = candidate?.chatType === 'group'
  const comparisonRequired = step === 'control' && candidate?.chatType === 'private' && !!candidate.comparisonCode
  const validToken = /^\d{5,}:\S{20,}$/.test(token.trim())

  useEffect(() => { if (!open) return; setStep('token'); setError(''); setBusy(false); setSetup(undefined); setStatus(undefined); setToken(''); setDedicated(false); setVisibility(false); setComparisonVerified(false); setTaskControl(false); setPermissions(['respond']) }, [open])
  useEffect(() => {
    if (!setup || (step !== 'connect' && step !== 'control')) return
    let cancelled = false
    const poll = async () => {
      try {
        const next = await api.status(projectId, setup.setupId)
        if (cancelled) return
        setStatus(next)
        if (next.status === 'expired') { setError('This setup link expired. Start again.'); setSetup(undefined); setStatus(undefined); setStep('token') }
      } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not read Telegram setup status.') }
    }
    void poll(); const timer = window.setInterval(() => void poll(), 2_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [api, projectId, setup, step])

  const begin = async (input: TelegramSetupBegin) => {
    setBusy(true); setError('')
    try {
      const begun = await api.begin(projectId, input)
      setSetup({ setupId: begun.setupId, receiverId: begun.receiverId, revision: '', deepLink: begun.deepLink }); setStatus(undefined); setStep('connect')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start Telegram setup.') } finally { setBusy(false) }
  }
  const start = () => { if (!validToken || !name.trim() || !dedicated) return; void begin({ token: token.trim(), name: name.trim(), dedicatedBot: true }) }
  const activateNotifications = async () => {
    if (!setup || !candidate || (group && !visibility) || !status) return
    setBusy(true); setError('')
      try { const result = await api.activate(projectId, setup.setupId, { expectedRevision: status.inboundRevision, candidateUserId: candidate.userId, taskControl: !group && taskControl, ...(!group && taskControl ? { permissions } : {}) }); setSetup({ ...setup, receiverId: result.receiverId ?? setup.receiverId, revision: result.inboundRevision }); setStep(!group && taskControl ? 'done' : 'activate'); onComplete?.() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not activate Telegram notifications.') } finally { setBusy(false) }
  }
  const beginControl = async () => {
    if (!setup || !taskControl || !status) { setStep('done'); onComplete?.(); return }
    setBusy(true); setError('')
    try { const begun = await api.begin(projectId, { receiverId: setup.receiverId, expectedRevision: status.inboundRevision, dedicatedBot: true, groupVisibilityAccepted: true as const }); setSetup({ setupId: begun.setupId, receiverId: begun.receiverId, revision: status.inboundRevision, deepLink: begun.deepLink }); setStatus(undefined); setComparisonVerified(false); setStep('control') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start task-control setup.') } finally { setBusy(false) }
  }
  const approve = async () => {
    if (!setup || !status?.candidate || (comparisonRequired && !comparisonVerified)) return
    setBusy(true); setError('')
    try { await api.activate(projectId, setup.setupId, { expectedRevision: status.inboundRevision, candidateUserId: status.candidate.userId, taskControl: true, permissions, ...(comparisonRequired ? { comparisonVerified: true as const } : {}) }); setStep('done'); onComplete?.() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not activate task control.') } finally { setBusy(false) }
  }
  const close = () => { if (setup) void api.cancel(projectId, setup.setupId).catch(() => undefined); onOpenChange(false) }
  const title = useMemo(() => ({ token: 'Connect Telegram', connect: 'Connect your Telegram chat', activate: 'Telegram notifications are active', control: 'Optional task control', done: 'Telegram is ready' }[step]), [step])
  return <Dialog open={open} onOpenChange={value => { if (!value) close() }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Connect a bot and chat, then choose whether to enable task control.</DialogDescription></DialogHeader>
    {step === 'token' && <div className="flex flex-col gap-4"><label className="flex flex-col gap-1.5 text-sm font-medium">Bot name<Input value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></label><label className="flex flex-col gap-1.5 text-sm font-medium">Bot token<Input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" placeholder="123456789:AA…" /></label><p className="text-ui text-muted-foreground">Create a bot with @BotFather. The token is saved only in this project’s secret store.</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={dedicated} onChange={event => setDedicated(event.target.checked)} />This bot is dedicated to this project: no other application receives its messages.</label><DialogFooter><Button onClick={start} disabled={!validToken || !name.trim() || !dedicated || busy}>{busy ? 'Starting…' : 'Continue'}</Button></DialogFooter></div>}
    {step === 'connect' && <div className="flex flex-col gap-4"><p className="text-sm">Open this link in Telegram and press <strong>Start</strong>:</p>{setup && <a className="break-all underline" href={setup.deepLink} target="_blank" rel="noreferrer">{setup.deepLink}</a>}{candidate ? <p role="status">Connected as <strong>{candidate.label}</strong>{candidate.username ? ` (@${candidate.username})` : ''} · Telegram ID {candidate.userId}</p> : <p role="status">Waiting for Telegram…</p>}{group && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={visibility} onChange={event => setVisibility(event.target.checked)} />I understand all members of this group can read project messages.</label>}{candidate && !group && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={taskControl} onChange={event => setTaskControl(event.target.checked)} />Enable task control for this private chat (uses this first Telegram identity; no second link).</label>}{group && <p className="text-ui text-muted-foreground">Task control requires a second private Start and code comparison after notifications are active.</p>}<DialogFooter><Button variant="outline" onClick={close}>Cancel</Button><Button onClick={() => void activateNotifications()} disabled={!candidate || !status || (group && !visibility) || busy}>{busy ? 'Activating…' : taskControl && !group ? 'Activate notifications and task control' : 'Activate notifications'}</Button></DialogFooter></div>}
    {step === 'activate' && <div className="flex flex-col gap-4"><p role="status">Notifications are active. Choose whether a person may control tasks.</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={taskControl} onChange={event => setTaskControl(event.target.checked)} />Enable optional task control for a Telegram person</label>{taskControl && <p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-ui">{risk}</p>}<DialogFooter><Button variant="outline" onClick={() => { setStep('done'); onComplete?.() }}>Skip task control</Button><Button onClick={() => void beginControl()} disabled={busy}>{busy ? 'Starting…' : 'Continue'}</Button></DialogFooter></div>}
    {step === 'control' && <div className="flex flex-col gap-4"><p className="text-sm">Open the private setup link and press Start to approve the person who may control tasks.</p>{setup && <a className="break-all underline" href={setup.deepLink} target="_blank" rel="noreferrer">{setup.deepLink}</a>}{candidate ? <p role="status"><strong>{candidate.label}</strong>{candidate.username ? ` (@${candidate.username})` : ''} · Telegram ID {candidate.userId}{candidate.comparisonCode ? ` · Comparison code: ${candidate.comparisonCode}` : ''}</p> : <p role="status">Waiting for Telegram…</p>}{comparisonRequired && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={comparisonVerified} onChange={event => setComparisonVerified(event.target.checked)} />I compared the code sent privately by Telegram. Task control stays disabled until this comparison is verified.</label>}{comparisonRequired && <p className="text-ui text-muted-foreground">Task control requires the second private Start and code comparison.</p>}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={permissions.includes('cancel')} onChange={event => setPermissions(event.target.checked ? [...permissions, 'cancel'] : permissions.filter(value => value !== 'cancel'))} />Allow cancel tasks</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={permissions.includes('continue')} onChange={event => setPermissions(event.target.checked ? [...permissions, 'continue'] : permissions.filter(value => value !== 'continue'))} />Allow continue tasks (may incur costs)</label><DialogFooter><Button variant="outline" onClick={close}>Cancel setup</Button><Button onClick={() => void approve()} disabled={!candidate || busy || (comparisonRequired && !comparisonVerified)}>{busy ? 'Activating…' : 'Activate task control'}</Button></DialogFooter></div>}
    {step === 'done' && <div className="flex flex-col gap-4"><p role="status">Telegram setup is complete. Notifications are active{taskControl ? ' and task control is enabled' : ''}.</p><DialogFooter><Button onClick={close}>Done</Button></DialogFooter></div>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </DialogContent></Dialog>
}
