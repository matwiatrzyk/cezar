import { useId, useRef, useState, type ReactNode } from 'react'
import { createWebhookSchema, updateWebhookSchema, type CreateWebhook, type UpdateWebhook, type WebhookReceiver, type WebhookTaskEventType } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { graceLabels, presetLabels, scopeLabels } from './webhook-presentation'
import { TelegramConnect, type ConnectTelegram } from './telegram-connect'
export const eventLabels: Record<WebhookTaskEventType | 'webhook.test', string> = {
  'task.attention_required': 'Needs your input', 'task.review_ready': 'Ready for review', 'task.finished': 'Task finished', 'task.failed': 'Task failed', 'task.cancelled': 'Task cancelled', 'webhook.test': 'Test message',
}
// Same chrome as the other Settings selects (resources-section).
const selectStyle = 'h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
const hintStyle = 'text-[13px] text-muted-foreground'
export type WebhookDraft = { format: CreateWebhook['format']; name: string; url: string; chatId: string; profile: CreateWebhook['profile']; preset: CreateWebhook['preset']; events: WebhookTaskEventType[]; scope: CreateWebhook['scope']; graceSeconds: CreateWebhook['graceSeconds']; local: boolean; scheduled: boolean }
export function webhookDraft(receiver?: WebhookReceiver): WebhookDraft {
  return { format: receiver?.format ?? 'cezar.json.v1', name: receiver?.name ?? '', url: '', chatId: receiver?.telegramChatId ?? '', profile: receiver?.profile ?? 'minimal', preset: receiver?.preset ?? 'attention', events: receiver?.events ?? [], scope: receiver?.scope ?? 'main_and_questions', graceSeconds: receiver?.graceSeconds ?? 180, local: receiver?.allowLocalNetwork ?? false, scheduled: receiver?.includeScheduledFailures ?? false }
}
const serviceNames = { 'cezar.json.v1': 'Custom', 'slack.v1': 'Slack', 'discord.v1': 'Discord', 'telegram.v1': 'Telegram' } as const
/** The cockpit asks for the bot token; the API accepts Telegram's sendMessage URL and vaults its token (spec 2026-10-27-telegram-webhook-receivers). */
export function telegramUrl(input: string): string {
  const value = input.trim()
  if (!value) return ''
  const token = /^https:\/\/api\.telegram\.org\/bot([^/?#\s]+)/i.exec(value)?.[1] ?? value.replace(/^bot/, '')
  return `https://api.telegram.org/bot${token}/sendMessage`
}
/** The well-formed token inside a pasted token or bot URL, if any. */
export function telegramToken(input: string): string | undefined {
  return /^https:\/\/api\.telegram\.org\/bot([0-9]{5,15}:[A-Za-z0-9_-]{30,64})\/sendMessage$/.exec(telegramUrl(input))?.[1]
}
function Field({ id, label, children }: { id?: string; label: string; children: ReactNode }) {
  return <div className="flex flex-col gap-1.5">{id ? <label htmlFor={id} className="text-sm font-medium">{label}</label> : <span className="text-sm font-medium">{label}</span>}{children}</div>
}
export function WebhookForm({ receiver, draft, setDraft, pending, blocked = false, guideHref, save, connectTelegram }: { receiver?: WebhookReceiver; draft: WebhookDraft; setDraft: (draft: WebhookDraft) => void; pending: boolean; blocked?: boolean; guideHref: string; save: (value: CreateWebhook | UpdateWebhook) => void; connectTelegram?: ConnectTelegram }) {
  const prefix = useId()
  const { format, name, url, chatId, profile, preset, events, scope, graceSeconds, local, scheduled } = draft
  const change = <K extends keyof WebhookDraft>(key: K, value: WebhookDraft[K]) => setDraft({ ...draft, [key]: value })
  // Polling resolves after later edits; it must not write back a stale draft.
  const latest = useRef(draft)
  latest.current = draft
  const [error, setError] = useState('')
  const chat = format !== 'cezar.json.v1'
  const telegram = format === 'telegram.v1'
  const destinationName = serviceNames[format]
  let suggestedFormat: WebhookDraft['format'] | undefined
  try {
    const host = new URL(url).hostname
    if (host === 'hooks.slack.com') suggestedFormat = 'slack.v1'
    if (['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com'].includes(host)) suggestedFormat = 'discord.v1'
    if (host === 'api.telegram.org') suggestedFormat = 'telegram.v1'
  } catch { /* Incomplete input. */ }
  // The token and URL share one field; never carry a bot token into a plain-text URL input, or back.
  const changeFormat = (value: WebhookDraft['format']) => setDraft({ ...draft, format: value, local: value === 'cezar.json.v1' && local,
    ...((value === 'telegram.v1') !== telegram && !(value === 'telegram.v1' && suggestedFormat === 'telegram.v1') ? { url: '' } : {}) })
  const token = telegram ? telegramToken(url) : undefined
  const connectSource = token ? { token } : receiver?.format === 'telegram.v1' && !url ? { receiverId: receiver.id } : undefined
  return <form className="flex flex-col gap-4" onSubmit={event => {
    event.preventDefault()
    if (pending || blocked) return
    const destination = telegram ? telegramUrl(url) : url
    const settings = { format, name, ...(destination || !receiver ? { url: destination } : {}), ...(telegram ? { telegramChatId: chatId } : {}), profile, preset, events, scope, graceSeconds, allowLocalNetwork: chat ? false : local, includeScheduledFailures: scheduled }
    const parsed = receiver ? updateWebhookSchema.safeParse({ ...settings, expectedRevision: receiver.revision }) : createWebhookSchema.safeParse(settings)
    if (!parsed.success) { setError([...new Set(parsed.error.issues.map(issue => issue.message.replace(/\.?$/, '.')))].join(' ')); return }
    setError(''); save(parsed.data)
  }}>
    <Field id={`${prefix}-destination`} label="Destination">
      <select id={`${prefix}-destination`} className={selectStyle} value={format} onChange={event => changeFormat(event.target.value as WebhookDraft['format'])}>
        <option value="cezar.json.v1">Custom receiver (signed cezar JSON)</option>
        <option value="slack.v1">Slack channel (Incoming Webhook)</option>
        <option value="discord.v1">Discord channel (Webhook URL)</option>
        <option value="telegram.v1">Telegram chat (bot)</option>
      </select>
    </Field>
    <Field id={`${prefix}-name`} label="Name"><Input id={`${prefix}-name`} value={name} onChange={event => change('name', event.target.value)} maxLength={100} required autoComplete="off" /></Field>
    <Field id={`${prefix}-url`} label={telegram ? 'Bot token' : chat ? 'Webhook URL' : 'Receiver URL'}>
      <Input id={`${prefix}-url`} type={telegram ? 'password' : 'url'} value={url} onChange={event => change('url', event.target.value)} required={!receiver} autoComplete="off" placeholder={receiver ? (telegram ? 'Leave blank to keep the current token' : 'Leave blank to keep the current URL') : format === 'slack.v1' ? 'https://hooks.slack.com/services/…' : format === 'discord.v1' ? 'https://discord.com/api/webhooks/…' : telegram ? '123456789:AA…' : 'https://your-receiver.example/webhook'} />
      {receiver && !telegram && <p className={hintStyle}>Current: {receiver.destination} (path hidden)</p>}
      {url.startsWith('http:') && <p className="text-[13px] text-warning">Plain HTTP is not encrypted. Use HTTPS outside a trusted local network.</p>}
      {!chat && suggestedFormat && <div role="status" className="flex flex-wrap items-center gap-2 text-[13px] text-warning">
        <span>{suggestedFormat === 'telegram.v1' ? 'This is a Telegram bot address. Switch the destination to post to a Telegram chat.' : `This is a ${serviceNames[suggestedFormat]} webhook. Switch the destination to post channel messages.`}</span>
        <Button type="button" size="sm" variant="outline" className="text-foreground" onClick={() => changeFormat(suggestedFormat!)}>Use {serviceNames[suggestedFormat]}</Button>
      </div>}
      {format === 'slack.v1' && <p className={hintStyle}>In Slack, create an app with an Incoming Webhook, install it in your channel and paste its URL. <a className="underline underline-offset-2 hover:text-foreground" href="https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks/" target="_blank" rel="noreferrer">Slack setup guide</a></p>}
      {format === 'discord.v1' && <p className={hintStyle}>In Discord, open Server Settings → Integrations → Webhooks, create one and paste its URL. <a className="underline underline-offset-2 hover:text-foreground" href="https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks" target="_blank" rel="noreferrer">Discord setup guide</a></p>}
      {telegram && <p className={hintStyle}>Create a bot with @BotFather, add it to your chat and paste its token. <a className="underline underline-offset-2 hover:text-foreground" href="https://core.telegram.org/bots/tutorial#obtain-your-bot-token" target="_blank" rel="noreferrer">Telegram setup guide</a></p>}
      {telegram ? <p className={hintStyle}>Cezar saves the token in this project’s secret store. Keep it secret — anyone who has it controls the bot. Telegram receivers need no signing key.</p>
        : chat ? <p className={hintStyle}>Keep this URL secret — anyone who has it can post to the channel. {destinationName} receivers need no signing key.</p> : <>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={local} onChange={event => change('local', event.target.checked)} />Allow a receiver on this computer or private network</label>
        {local && <p className={hintStyle}>Tests will contact this private address. Hosted cezar sends to public HTTPS receivers only.</p>}
        <a className="text-[13px] text-muted-foreground underline underline-offset-2 hover:text-foreground" href={`${guideHref}#external-automation-receivers`} target="_blank" rel="noreferrer">How to build a receiver</a>
      </>}
    </Field>
    {telegram && <Field id={`${prefix}-chat`} label="Chat ID">
      <Input id={`${prefix}-chat`} value={chatId} onChange={event => change('chatId', event.target.value)} required autoComplete="off" placeholder="-1001234567890 or @channelname" />
      {connectTelegram && <TelegramConnect source={connectSource} selectedChatId={chatId} connect={connectTelegram} onChat={chat => setDraft({ ...latest.current, chatId: chat.id })} />}
      <p className={hintStyle}>Or enter it by hand: group and channel IDs are negative (supergroups and channels start with -100); a public channel may use its @username. In a private chat, send /start to the bot first — bots cannot start a conversation.</p>
    </Field>}
    <Field id={`${prefix}-events`} label="Events"><select id={`${prefix}-events`} className={selectStyle} value={preset} onChange={event => change('preset', event.target.value as CreateWebhook['preset'])}>
      {(['attention', 'all', 'custom'] as const).map(value => <option key={value} value={value}>{presetLabels[value]}</option>)}</select></Field>
    {preset === 'custom' && <fieldset className="flex flex-col gap-2"><legend className="mb-1 text-sm font-medium">Choose events</legend>{Object.entries(eventLabels).filter(([type]) => type !== 'webhook.test').map(([type, label]) => <label key={type} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={events.includes(type as WebhookTaskEventType)} onChange={event => change('events', event.target.checked ? [...events, type as WebhookTaskEventType] : events.filter(value => value !== type))} />{label}</label>)}</fieldset>}
    <Field id={`${prefix}-profile`} label="Message content"><select id={`${prefix}-profile`} className={selectStyle} value={profile} onChange={event => change('profile', event.target.value as CreateWebhook['profile'])}><option value="minimal">Minimal — IDs, status and your own title</option><option value="standard">Standard — task titles, questions and errors</option></select>
      <p className={hintStyle}>Prompts and transcripts are never sent. Redaction of other text is best effort.</p>
      {chat && profile === 'standard' && <p className="text-[13px] text-warning">Standard posts task titles, questions and error text to your {destinationName} {telegram ? 'chat' : 'channel'}.</p>}
    </Field>
    {chat ? <ChatPreview format={format} profile={profile} /> : <details><summary className="cursor-pointer text-sm font-medium">Preview JSON · {profile === 'minimal' ? 'Minimal' : 'Standard'}</summary>
      <p className={`mt-2 ${hintStyle}`}>Example data only — nothing is sent.</p>
      <pre aria-label="Synthetic JSON sample" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 text-xs">{JSON.stringify({
        id: 'evt_00000000-0000-4000-8000-000000000001', schemaVersion: 1, sequence: 1,
        occurredAt: '2026-01-01T12:00:00Z', type: 'task.attention_required',
        source: { instanceId: 'example-instance', projectId: 'example-project', mode: 'local' },
        task: { id: 'example-task', previousStatus: 'running', status: 'waiting', ...(profile === 'standard' ? { title: 'Example generated task title' } : {}) },
        data: { episodeId: 'example-episode', since: '2026-01-01T12:00:00Z', reason: 'question', requestId: 'example-request', ...(profile === 'standard' ? { questions: [{ question: 'Which example option should be used?', options: [{ label: 'Example A' }, { label: 'Example B' }] }] } : {}) },
      }, null, 2)}</pre>
    </details>}
    <details><summary className="cursor-pointer text-sm font-medium">Advanced</summary><div className="mt-3 flex flex-col gap-4">
      <Field id={`${prefix}-scope`} label="Tasks"><select id={`${prefix}-scope`} className={selectStyle} value={scope} onChange={event => change('scope', event.target.value as CreateWebhook['scope'])}>{(['main_and_questions', 'every_task'] as const).map(value => <option key={value} value={value}>{scopeLabels[value]}</option>)}</select></Field>
      <Field id={`${prefix}-grace`} label="Waiting and review delay"><select id={`${prefix}-grace`} className={selectStyle} value={graceSeconds} onChange={event => change('graceSeconds', Number(event.target.value) as CreateWebhook['graceSeconds'])}>{([0, 60, 180, 600] as const).map(value => <option key={value} value={value}>{graceLabels[value]}</option>)}</select><p className={hintStyle}>Skipped if you reply, or the task stops waiting or leaves review, before the delay ends.</p></Field>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-0.5" checked={scheduled} onChange={event => change('scheduled', event.target.checked)} />Include failures that will resume automatically (always included in All results)</label>
    </div></details>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    <div><Button type="submit" disabled={pending || blocked}>{pending ? 'Saving…' : receiver ? 'Review changes' : 'Save receiver'}</Button></div>
  </form>
}

function ChatPreview({ format, profile }: { format: WebhookDraft['format']; profile: WebhookDraft['profile'] }) {
  const service = serviceNames[format]
  const telegram = format === 'telegram.v1'
  return <details>
    <summary className="cursor-pointer text-sm font-medium">Preview {service} message · {profile === 'minimal' ? 'Minimal' : 'Standard'}</summary>
    <p className={`mt-2 ${hintStyle}`}>Example data only — nothing is sent.</p>
    <div aria-label={`${service} message sample`} className={`mt-2 space-y-2 rounded-md border border-border bg-muted p-3 text-sm ${format === 'discord.v1' ? 'border-l-4 border-l-pending' : ''}`}>
      <p className="font-medium">Needs your input · {profile === 'standard' ? 'Example generated task title' : 'a1b2c3d4'}</p>
      {telegram ? <><p>Project: example-project</p><p>Status: Waiting for your answer (was running)</p><p>Task: <code>a1b2c3d4</code></p></> : <><p>running → waiting</p><p className="text-xs text-muted-foreground">example-project · a1b2c3d4 · Jan 1, 2026, 12:00 UTC</p></>}
      {profile === 'standard' && <div><p>Which example option should be used?</p><p>Example A · Example B</p></div>}
      {!telegram && <p className="text-xs text-muted-foreground">cezar</p>}
    </div>
  </details>
}
