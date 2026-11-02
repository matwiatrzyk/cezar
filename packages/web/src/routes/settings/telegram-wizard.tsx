import { useEffect, useMemo, useState } from 'react'
import type { TelegramInboundGrant, TelegramSetupStatus, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { telegramApi, webhookApi } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { TelegramConnect } from './telegram-connect'
import { telegramToken, telegramUrl } from './webhook-form'
import { defaultSetupApi, type TelegramSetupApi } from './telegram-inbound'

type Step = 'token' | 'connect' | 'activate' | 'control' | 'done'
const graceSeconds = 60
const risk = 'Task control lets a person start tasks and instruct agents that run shell commands on this machine. Starting or continuing work may incur provider costs.'

/** The single entry point for a new Telegram connection. Existing receiver and pairing APIs are
 * deliberately used here so this UI can ship before the server-side setup endpoint changes. */
export function TelegramWizard({ projectId, open, onOpenChange, onComplete, setupApi }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; onComplete?: () => void; setupApi?: TelegramSetupApi }) {
  const [step, setStep] = useState<Step>('token')
  const [name, setName] = useState('Telegram notifications')
  const [token, setToken] = useState('')
  const [chatId, setChatId] = useState('')
  const [chatTitle, setChatTitle] = useState('')
  const [standard, setStandard] = useState(true)
  const [dedicated, setDedicated] = useState(false)
  const [visibility, setVisibility] = useState(false)
  const [comparisonVerified, setComparisonVerified] = useState(false)
  const [taskControl, setTaskControl] = useState(false)
  const [permissions, setPermissions] = useState<TelegramInboundGrant['permissions']>(['respond'])
  const [receiver, setReceiver] = useState<WebhookReceiver>()
  const [setup, setSetup] = useState<{ setupId: string; receiverId: string; revision: string }>()
  const [candidate, setCandidate] = useState<TelegramSetupStatus['candidate']>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const validToken = !!telegramToken(token)
  const group = /^-/.test(chatId)
  const api = setupApi ?? defaultSetupApi
  useEffect(() => { if (!open) return; setStep('token'); setError(''); setBusy(false); setReceiver(undefined); setSetup(undefined); setCandidate(undefined); setChatId(''); setChatTitle(''); setTaskControl(false); setVisibility(false); setComparisonVerified(false); setDedicated(false); setPermissions(['respond']) }, [open])
  useEffect(() => {
    if (!setup || step !== 'control') return
    let cancelled = false
    const poll = async () => { try { const result = await api.status(projectId, setup.setupId); if (cancelled) return; if (result.status === 'candidate') { setCandidate(result.candidate); return } if (result.status === 'expired') { setError('This setup link expired. Start again.'); setStep('connect') } } catch (cause) { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not read Telegram setup status.') } }
    void poll(); const timer = window.setInterval(() => void poll(), 2_000); return () => { cancelled = true; window.clearInterval(timer) }
  }, [api, projectId, setup, step])
  const connect = async () => { if (!validToken || !name.trim()) return; setError(''); setStep('connect') }
  const onChat = (chat: { id: string; title: string }) => { setChatId(chat.id); setChatTitle(chat.title) }
  const create = async () => {
    const parsedToken = telegramToken(token); if (!parsedToken || !chatId || (group && !visibility) || !standard) return
    setBusy(true); setError('')
    try {
      const created = await webhookApi.create(projectId, { format: 'telegram.v1', name: name.trim(), url: telegramUrl(parsedToken), telegramChatId: chatId, profile: 'standard', preset: 'attention', events: [], scope: 'main_and_questions', graceSeconds, allowLocalNetwork: false, includeScheduledFailures: false })
      const row = created.receiver as WebhookReceiver; setReceiver(row)
      const tested = await webhookApi.test(projectId, row.id, { expectedRevision: row.revision, deliveryRevision: row.deliveryRevision, operationId: crypto.randomUUID() })
      const activated = await webhookApi.activate(projectId, row.id, tested.receiver?.revision ?? row.revision)
      setReceiver(activated.receiver as WebhookReceiver)
      setStep('activate'); onComplete?.()
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create the Telegram receiver.') } finally { setBusy(false) }
  }
  const beginControl = async () => {
    if (!receiver || !taskControl) { setStep('done'); onComplete?.(); return }
    setBusy(true); setError('')
    try { const telegram = await telegramApi.list(projectId); const current = telegram.receivers.find(row => row.receiverId === receiver.id); if (!current) throw new Error('Telegram receiver is not ready for task control. Refresh and try again.'); const begun = await api.begin(projectId, { receiverId: receiver.id, expectedRevision: current.inboundRevision, dedicatedBot: true, ...(group ? { groupVisibilityAccepted: true as const } : {}) }); setSetup({ setupId: begun.setupId, receiverId: begun.receiverId, revision: begun.inboundRevision ?? current.inboundRevision }); setStep('control') }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start task-control setup.') } finally { setBusy(false) }
  }
  const approve = async () => {
    if (!setup || !candidate || (group && !comparisonVerified)) return
    setBusy(true); setError('')
    try { await api.activate(projectId, setup.setupId, { expectedRevision: setup.revision, candidateUserId: candidate.userId, permissions, ...(group ? { comparisonVerified: true as const } : {}) }); setStep('done'); onComplete?.() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not activate task control.') } finally { setBusy(false) }
  }
  const close = () => { if (setup) void api.cancel(projectId, setup.setupId).catch(() => undefined); onOpenChange(false) }
  const title = useMemo(() => ({ token: 'Connect Telegram', connect: 'Connect your Telegram chat', activate: 'Telegram notifications are active', control: 'Optional task control', done: 'Telegram is ready' }[step]), [step])
  return <Dialog open={open} onOpenChange={value => { if (!value) close() }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>One guided setup for notifications and optional task control. You can return to diagnostics and revoke access at any time.</DialogDescription></DialogHeader>
    {step === 'token' && <div className="flex flex-col gap-4"><label className="flex flex-col gap-1.5 text-sm font-medium">Bot name<Input value={name} onChange={event => setName(event.target.value)} autoComplete="off" /></label><label className="flex flex-col gap-1.5 text-sm font-medium">Bot token<Input type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" placeholder="123456789:AA…" /></label><p className="text-ui text-muted-foreground">Create a bot with @BotFather. The token is saved only in this project’s secret store.</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={dedicated} onChange={event => setDedicated(event.target.checked)} />This bot is dedicated to this project: no other application receives its messages.</label><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={standard} onChange={event => setStandard(event.target.checked)} />I understand Standard sends task titles, questions and error text to this Telegram chat.</label><DialogFooter><Button onClick={() => void connect()} disabled={!validToken || !name.trim() || !standard || !dedicated}>Continue</Button></DialogFooter></div>}
    {step === 'connect' && <div className="flex flex-col gap-4"><p className="text-sm">Connect a private chat or group. Open the link in Telegram and press <strong>Start</strong>.</p><TelegramConnect source={{ token: telegramToken(token)! }} selectedChatId={chatId} connect={(input, signal) => webhookApi.telegramConnect(projectId, input, signal)} onChat={onChat} />{chatTitle && <p role="status">Selected: <strong>{chatTitle}</strong> · {chatId}</p>}{group && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={visibility} onChange={event => setVisibility(event.target.checked)} />I understand all members of this group can read project messages.</label>}<DialogFooter><Button variant="outline" onClick={() => setStep('token')}>Back</Button><Button onClick={() => void create()} disabled={!chatId || !standard || (group && !visibility) || busy}>{busy ? 'Activating notifications…' : 'Activate notifications'}</Button></DialogFooter></div>}
    {step === 'activate' && <div className="flex flex-col gap-4"><p role="status">Notifications are active for {receiver?.destination ?? chatTitle}. Choose whether this chat may control tasks.</p><label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={taskControl} onChange={event => setTaskControl(event.target.checked)} />Enable optional task control for a Telegram person</label>{taskControl && <p className="rounded-md border border-warning/50 bg-warning/10 p-3 text-ui">{risk}</p>}<DialogFooter><Button variant="outline" onClick={() => { setStep('done'); onComplete?.() }}>Skip task control</Button><Button onClick={() => void beginControl()} disabled={busy}>{busy ? 'Starting…' : 'Continue'}</Button></DialogFooter></div>}
    {step === 'control' && <div className="flex flex-col gap-4"><p className="text-sm">Open the private setup link and press Start to approve the person who may control tasks.</p>{candidate ? <p role="status"><strong>{candidate.label}</strong>{candidate.username ? ` (@${candidate.username})` : ''} · Telegram ID {candidate.userId}{candidate.comparisonCode ? ` · Comparison code: ${candidate.comparisonCode}` : ''}</p> : <p role="status">Waiting for Telegram…</p>}{group && <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={comparisonVerified} onChange={event => setComparisonVerified(event.target.checked)} />I compared the code sent privately by Telegram and understand group members can read project messages.</label>}<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={permissions.includes('cancel')} onChange={event => setPermissions(event.target.checked ? [...permissions, 'cancel'] : permissions.filter(value => value !== 'cancel'))} />Allow cancel tasks</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={permissions.includes('continue')} onChange={event => setPermissions(event.target.checked ? [...permissions, 'continue'] : permissions.filter(value => value !== 'continue'))} />Allow continue tasks (may incur costs)</label><DialogFooter><Button variant="outline" onClick={close}>Cancel setup</Button><Button onClick={() => void approve()} disabled={!candidate || busy || (group && !comparisonVerified)}>{busy ? 'Activating…' : 'Activate task control'}</Button></DialogFooter></div>}
    {step === 'done' && <div className="flex flex-col gap-4"><p role="status">Telegram setup is complete. Notifications are active{taskControl ? ' and task control is enabled' : ''}.</p><DialogFooter><Button onClick={close}>Done</Button></DialogFooter></div>}
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
  </DialogContent></Dialog>
}
