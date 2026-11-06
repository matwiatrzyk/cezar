import { ExtensionChatError, defineExtension, type ExtensionChatAdapter, type ExtensionChatBatch } from '@open-mercato/cezar-extension-sdk'

type User = { id: string; username: string }
type Channel = { id: string; type: 'D' | 'G' | 'O' | 'P'; delete_at: number }
type Post = { id: string; user_id: string; channel_id: string; message: string; create_at: number; delete_at: number; root_id: string; type: string }
const rawId = (id: string) => {
  const raw = id.replace(/^(private|group):/, '')
  if (!/^[a-z0-9]{26}$/.test(raw)) throw Error('Invalid Mattermost identifier')
  return raw
}
export default defineExtension({
  activate(context) {
    return context.chat.register('chat', credentials => {
      const server = new URL(credentials.server!)
      if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) throw Error('Use a Mattermost HTTPS server URL')
      const base = server.origin
      const headers = { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' }
      const started = Date.now()
      const abort = new AbortController()
      async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
        const response = await fetch(`${base}/api/v4${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(20_000)]) })
        if (!response.ok) throw new ExtensionChatError({ kind: response.status === 401 || response.status === 403 ? 'auth' : response.status === 429 ? 'rate_limited' : response.status === 404 ? 'gone' : 'transient', ...(response.status === 429 ? { retryAfterMs: Math.max(1000, Number(response.headers.get('retry-after') ?? 1) * 1000) } : {}) })
        return response.json() as Promise<T>
      }
      let me: User | undefined
      const identity = async () => me ??= await request<User>('/users/me')
      const channels = async () => (await request<Channel[]>(`/users/${(await identity()).id}/channels`)).filter(channel => !channel.delete_at).slice(0, 20)
      const kind = (channel: Channel) => channel.type === 'D' ? 'private' as const : 'group' as const
      const adapter: ExtensionChatAdapter = {
        async identify() { const user = await identity(); return { id: user.id, username: user.username, discoveryUrl: `${base}/messages/@${encodeURIComponent(user.username)}` } },
        async inspect(id) { const channel = await request<Channel>(`/channels/${rawId(id)}`); return { id: `${kind(channel)}:${channel.id}`, kind: kind(channel), eligible: !channel.delete_at } },
        async send(chatId, message) {
          const post = await request<Post>('/posts', { channel_id: rawId(chatId), message: message.text, ...(message.replyTo ? { root_id: rawId(message.replyTo.messageId) } : {}) })
          return { chatId, messageId: post.id }
        },
        // This adapter advertises zero buttons; all interaction uses text commands/replies.
        async clearButtons() {},
        async acknowledge() {},
        async isMember(chatId, userId) {
          try { await request(`/channels/${rawId(chatId)}/members/${rawId(userId)}`); return true } catch { return false }
        },
        async receive(after) {
          const self = await identity()
          const batch: ExtensionChatBatch = []
          for (const channel of await channels()) {
            const result = await request<{ posts: Record<string, Post> }>(`/channels/${channel.id}/posts?since=${Math.max(0, (after ?? started) - 1)}`)
            for (const post of Object.values(result.posts)) {
              if (post.user_id === self.id || post.delete_at || post.type || post.create_at < (after ?? started)) continue
              const chat = { id: `${kind(channel)}:${channel.id}`, kind: kind(channel) }
              const addressed = chat.kind === 'private' || post.message.startsWith('cezar ') || post.message.includes(`@${self.username}`)
              const mention = `@${self.username} `
              const text = (post.message.startsWith(mention) ? post.message.slice(mention.length) : post.message).replace(/^cezar\s+/, '/')
              batch.push({ sequence: post.create_at, event: { id: post.id, kind: 'message', chat,
                user: { id: post.user_id, label: post.user_id }, messageId: post.id, at: post.create_at,
                text, addressed, ...(post.root_id ? { replyTo: { chatId: chat.id, messageId: post.root_id } } : {}) } })
            }
          }
          return batch.sort((a, b) => a.sequence - b.sequence || a.event.id.localeCompare(b.event.id)).slice(0, 100)
        },
        async dispose() { abort.abort() },
      }
      return adapter
    })
  },
})
