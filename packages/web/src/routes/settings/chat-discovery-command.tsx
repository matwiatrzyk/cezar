import type { ChatProviderDescriptor } from '@/lib/chat-providers'

/** Setup codes authorize discovery only; sending the command never grants task control. */
export function ChatDiscoveryCommand({ provider, link, group = false }: {
 provider: ChatProviderDescriptor; link: string; group?: boolean
}) {
 const command = provider.bot?.discoveryCommand?.(link, group)
 if (!command) return null
 const label = group ? 'Command for group or channel' : 'Command for private chat'
 return <label className="flex flex-col gap-1 text-ui">
  <span>{label} — copy and send it to the bot.</span>
  <input aria-label={label} className="rounded border bg-background px-2 py-1 font-mono" readOnly value={command} onFocus={event => event.currentTarget.select()} />
 </label>
}
