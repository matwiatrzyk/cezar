import { useId, useState } from 'react'
import { createWebhookSchema, updateWebhookSchema, type CreateWebhook, type UpdateWebhook, type WebhookReceiver, type WebhookTaskEventType } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
export const eventLabels: Record<WebhookTaskEventType | 'webhook.test', string> = {
  'task.attention_required': 'Needs your input', 'task.review_ready': 'Ready for review', 'task.finished': 'Task finished', 'task.failed': 'Task failed', 'task.cancelled': 'Task cancelled', 'webhook.test': 'Test message',
}
const selectStyle = 'outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 w-full rounded-md border border-input bg-background px-3 py-2 text-sm'
export type WebhookDraft = { name: string; url: string; profile: CreateWebhook['profile']; preset: CreateWebhook['preset']; events: WebhookTaskEventType[]; scope: CreateWebhook['scope']; graceSeconds: CreateWebhook['graceSeconds']; local: boolean; scheduled: boolean }
export function webhookDraft(receiver?: WebhookReceiver): WebhookDraft {
  return { name: receiver?.name ?? '', url: '', profile: receiver?.profile ?? 'minimal', preset: receiver?.preset ?? 'attention', events: receiver?.events ?? [], scope: receiver?.scope ?? 'main_and_questions', graceSeconds: receiver?.graceSeconds ?? 180, local: receiver?.allowLocalNetwork ?? false, scheduled: receiver?.includeScheduledFailures ?? false }
}
export function WebhookForm({ receiver, draft, setDraft, pending, blocked = false, save }: { receiver?: WebhookReceiver; draft: WebhookDraft; setDraft: (draft: WebhookDraft) => void; pending: boolean; blocked?: boolean; save: (value: CreateWebhook | UpdateWebhook) => void }) {
  const prefix = useId()
  const { name, url, profile, preset, events, scope, graceSeconds, local, scheduled } = draft
  const change = <K extends keyof WebhookDraft>(key: K, value: WebhookDraft[K]) => setDraft({ ...draft, [key]: value })
  const [error, setError] = useState('')
  return <form className="space-y-4" onSubmit={event => {
    event.preventDefault()
    if (pending || blocked) return
    const settings = { name, ...(url || !receiver ? { url } : {}), profile, preset, events, scope, graceSeconds, allowLocalNetwork: local, includeScheduledFailures: scheduled }
    const parsed = receiver ? updateWebhookSchema.safeParse({ ...settings, expectedRevision: receiver.revision }) : createWebhookSchema.safeParse(settings)
    if (!parsed.success) { setError(parsed.error.issues.map(issue => issue.message).join('. ')); return }
    setError(''); save(parsed.data)
  }}>
    <div><label htmlFor={`${prefix}-name`}>Name</label><Input id={`${prefix}-name`} value={name} onChange={event => change('name', event.target.value)} maxLength={100} required autoComplete="off" /></div>
    <div><label htmlFor={`${prefix}-url`}>Receiver URL</label><Input id={`${prefix}-url`} type="url" value={url} onChange={event => change('url', event.target.value)} required={!receiver} autoComplete="off" placeholder={receiver ? 'Leave blank to keep the current destination' : 'https://receiver.example/webhook'} />
      {receiver && <p className="text-sm text-soft-foreground">Current destination: {receiver.destination}. Its private path is not displayed.</p>}
      {url.startsWith('http:') && <p className="text-sm text-warning">Plain HTTP is not encrypted. Use HTTPS for destinations beyond a trusted local network.</p>}
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={local} onChange={event => change('local', event.target.checked)} />Allow a receiver on this computer or private network</label>
      {local && <p className="text-sm text-soft-foreground">Testing will contact this private destination. Hosted cezar permits public HTTPS receivers only.</p>}</div>
    <div><label htmlFor={`${prefix}-events`}>Events</label><select id={`${prefix}-events`} className={selectStyle} value={preset} onChange={event => change('preset', event.target.value as CreateWebhook['preset'])}>
      <option value="attention">Attention, review and results</option><option value="all">All results</option><option value="custom">Custom</option></select></div>
    {preset === 'custom' && <fieldset className="space-y-2"><legend className="text-sm">Choose events</legend>{Object.entries(eventLabels).filter(([type]) => type !== 'webhook.test').map(([type, label]) => <label key={type} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={events.includes(type as WebhookTaskEventType)} onChange={event => change('events', event.target.checked ? [...events, type as WebhookTaskEventType] : events.filter(value => value !== type))} />{label}</label>)}</fieldset>}
    <div><label htmlFor={`${prefix}-profile`}>Message content</label><select id={`${prefix}-profile`} className={selectStyle} value={profile} onChange={event => change('profile', event.target.value as CreateWebhook['profile'])}><option value="minimal">Minimal — IDs, status and your own title</option><option value="standard">Standard — task titles, questions and errors</option></select>
      <p className="text-sm text-soft-foreground">Prompts and transcripts are never included. Redaction cannot guarantee that all sensitive text is removed.</p></div>
    <figure className="rounded-md border border-border bg-muted/30 p-3 text-sm">
      <figcaption className="mb-1 font-medium">Example notification · {profile === 'minimal' ? 'Minimal' : 'Standard'}</figcaption>
      <p>{profile === 'minimal' ? 'Task a1b2c3d4 · example-project · Needs your input' : 'Update checkout validation · Which payment options should be supported?'}</p>
      <p className="mt-1 text-xs text-soft-foreground">Illustrative rendering of the signed JSON. Minimal uses the task ID when the title was generated by an agent.</p>
    </figure>
    <details><summary className="cursor-pointer text-sm">Preview synthetic JSON · {profile === 'minimal' ? 'Minimal' : 'Standard'}</summary>
      <p className="text-sm text-soft-foreground">Generated locally from fictional data. Nothing is sent and no real task is read.</p>
      <pre aria-label="Synthetic JSON sample" className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-3 text-xs">{JSON.stringify({
        id: 'evt_00000000-0000-4000-8000-000000000001', schemaVersion: 1, sequence: 1,
        occurredAt: '2026-01-01T12:00:00Z', type: 'task.attention_required',
        source: { instanceId: 'example-instance', projectId: 'example-project', mode: 'local' },
        task: { id: 'example-task', previousStatus: 'running', status: 'waiting', ...(profile === 'standard' ? { title: 'Example generated task title' } : {}) },
        data: { episodeId: 'example-episode', since: '2026-01-01T12:00:00Z', reason: 'question', requestId: 'example-request', ...(profile === 'standard' ? { questions: [{ question: 'Which example option should be used?', options: [{ label: 'Example A' }, { label: 'Example B' }] }] } : {}) },
      }, null, 2)}</pre>
    </details>
    <details><summary className="cursor-pointer text-sm">Advanced</summary><div className="mt-3 space-y-3">
      <div><label htmlFor={`${prefix}-scope`}>Tasks</label><select id={`${prefix}-scope`} className={selectStyle} value={scope} onChange={event => change('scope', event.target.value as CreateWebhook['scope'])}><option value="main_and_questions">Main tasks and questions from child tasks</option><option value="every_task">Every task</option></select></div>
      <div><label htmlFor={`${prefix}-grace`}>Waiting and review delay</label><select id={`${prefix}-grace`} className={selectStyle} value={graceSeconds} onChange={event => change('graceSeconds', Number(event.target.value) as CreateWebhook['graceSeconds'])}><option value={0}>Immediately</option><option value={60}>1 minute</option><option value={180}>3 minutes</option><option value={600}>10 minutes</option></select><p className="text-sm text-soft-foreground">Skipped if you reply or the task leaves waiting or review before delivery. Freshness is checked again before each attempt, including after the delay.</p></div>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={scheduled} onChange={event => change('scheduled', event.target.checked)} />Include failures with an automatic resume scheduled (always included in All results)</label>
    </div></details>
    {error && <p role="alert" className="text-danger">{error}</p>}
    <Button type="submit" disabled={pending || blocked}>{pending ? 'Saving…' : receiver ? 'Review changes' : 'Save receiver'}</Button>
  </form>
}
