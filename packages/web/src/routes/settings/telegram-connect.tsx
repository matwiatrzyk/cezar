import { useEffect, useRef, useState } from 'react'
import type { TelegramChat, TelegramConnect as TelegramConnectInput, TelegramConnectResponse } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'

export type ConnectTelegram = (input: TelegramConnectInput, signal: AbortSignal) => Promise<TelegramConnectResponse>
// Spec 2026-10-27-telegram-webhook-receivers §5a: poll briefly after the user opens the start link.
const POLL_MS = 3000
const WINDOW_MS = 120_000
const hintStyle = 'text-[13px] text-muted-foreground'
const linkStyle = 'underline underline-offset-2 hover:text-foreground'
const chatTypes: Record<TelegramChat['type'], string> = { private: 'private chat', group: 'group', supergroup: 'group', channel: 'channel' }

function oneTimeCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => alphabet[byte % alphabet.length]).join('')
}

/** `source` is the token for a new receiver, or the receiver ID to reuse its saved token. */
export function TelegramConnect({ source, connect, onChat }: { source?: { token: string } | { receiverId: string }; connect: ConnectTelegram; onChat: (chat: TelegramChat) => void }) {
  const [state, setState] = useState<{ code: string; bot: TelegramConnectResponse['bot']; chats: TelegramChat[]; waiting: boolean; matched?: TelegramChat } | undefined>()
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const run = useRef<AbortController | undefined>(undefined)
  const onChatRef = useRef(onChat)
  onChatRef.current = onChat
  const key = source ? JSON.stringify(source) : ''
  // A changed token or receiver invalidates the session; leaving the form stops polling.
  useEffect(() => () => { run.current?.abort(); setState(undefined); setError('') }, [key])

  const start = async () => {
    if (!source) return
    run.current?.abort()
    const controller = new AbortController(); run.current = controller
    const code = oneTimeCode(); const until = Date.now() + WINDOW_MS
    setError(''); setPending(true)
    try {
      for (let first = true; !controller.signal.aborted; first = false) {
        let result: TelegramConnectResponse
        try { result = await connect({ ...source, code }, controller.signal) }
        catch (failure) {
          // Only the first call reports: once the bot is known, a dropped poll (seen live) just retries.
          if (first || Date.now() >= until) throw failure
          await new Promise(resolve => setTimeout(resolve, POLL_MS)); continue
        }
        if (controller.signal.aborted) return
        if (result.match) { setState({ code, bot: result.bot, chats: result.chats, waiting: false, matched: result.match }); onChatRef.current(result.match); return }
        const waiting = Date.now() < until
        setState({ code, bot: result.bot, chats: result.chats, waiting })
        if (first) setPending(false)
        if (!waiting) return
        await new Promise(resolve => setTimeout(resolve, POLL_MS))
      }
    } catch (failure) {
      if (!controller.signal.aborted) { setError(failure instanceof Error ? failure.message : 'Could not reach Telegram.'); setState(undefined) }
    } finally { if (run.current === controller) setPending(false) }
  }

  if (!state) return <div className="flex flex-col gap-1.5">
    <div><Button type="button" size="sm" variant="outline" disabled={!source || pending} onClick={() => void start()}>{pending ? 'Connecting…' : 'Connect chat'}</Button></div>
    <p className={hintStyle}>{source ? 'Opens a link that starts your bot in Telegram and fills in the chat ID.' : 'Enter the bot token first.'}</p>
    {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
  </div>
  const bot = `https://t.me/${encodeURIComponent(state.bot.username)}`
  return <div role="status" aria-label="Telegram connection" className="flex flex-col gap-1.5 rounded-md border border-border p-3 text-[13px]">
    <p>Bot: <span className="font-medium">@{state.bot.username}</span> ({state.bot.name})</p>
    {state.matched ? <p>Connected to <span className="font-medium">{state.matched.title}</span> <span className="text-muted-foreground">· {chatTypes[state.matched.type]} · {state.matched.id}</span>. Save, then send a test.</p>
      : state.waiting ? <>
      <p>Open one of these in Telegram and press <span className="font-medium">Start</span>:</p>
      <p className="flex flex-wrap gap-3">
        <a className={linkStyle} href={`${bot}?start=${state.code}`} target="_blank" rel="noreferrer">Private chat with the bot</a>
        <a className={linkStyle} href={`${bot}?startgroup=${state.code}`} target="_blank" rel="noreferrer">Add the bot to a group</a>
      </p>
      <p className="text-muted-foreground">For a channel, add the bot as an admin and post <code className="rounded bg-muted px-1">{state.code}</code> there.</p>
      <p className="text-muted-foreground">Waiting for Telegram…</p>
    </> : <p className="text-muted-foreground">Stopped waiting. <button type="button" className={linkStyle} onClick={() => void start()}>Try again</button></p>}
    {!state.matched && state.chats.length > 0 && <div className="flex flex-col gap-1">
      <p className="text-muted-foreground">Or pick a chat the bot already knows:</p>
      <ul className="flex flex-col gap-1">{state.chats.map(chat => <li key={chat.id} className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate">{chat.title} <span className="text-muted-foreground">· {chatTypes[chat.type]} · {chat.id}</span></span>
        <Button type="button" size="sm" variant="ghost" onClick={() => { run.current?.abort(); setPending(false); setState({ ...state, waiting: false, matched: chat }); onChat(chat) }}>Use</Button>
      </li>)}</ul>
    </div>}
  </div>
}
