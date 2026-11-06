import type { ChatProviderDescriptor } from '@/lib/chat-providers'
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { telegramInboundInvalidationSchema } from '@open-mercato/cezar-api-client'
import { subscribeTopic } from '@/api/ws'
export const telegramKey = (projectId: string) => [projectId, 'telegram-inbound'] as const
export function useTelegramSubscription(projectId: string, enabled: boolean) {
  const client = useQueryClient()
  useEffect(() => {
    if (!enabled) return
    return subscribeTopic('telegram-inbound', data => {
      if (telegramInboundInvalidationSchema.safeParse(data).success) void client.invalidateQueries({ queryKey: telegramKey(projectId) })
    })
  }, [client, projectId, enabled])
}

export const chatKey = (projectId: string, providerId: string) => [projectId, `${providerId}-inbound`] as const
export function useChatSubscription(projectId: string, enabled: boolean, provider: ChatProviderDescriptor) {
 const client = useQueryClient()
 useEffect(() => {
  if (!enabled || !provider.bot) return
  return provider.bot.subscribe(() => { void client.invalidateQueries({ queryKey: chatKey(projectId, provider.id) }) })
 }, [client, projectId, enabled, provider])
}

/** One subscription per bot provider for views that list several (the integrations gallery). Keyed by
 *  provider ids, so a re-render with the same providers keeps its subscriptions. */
export function useChatSubscriptions(projectId: string, providers: readonly ChatProviderDescriptor[]) {
 const client = useQueryClient()
 const ids = providers.filter(provider => provider.bot).map(provider => provider.id).join('\n')
 const latest = useRef(providers)
 useEffect(() => { latest.current = providers })
 useEffect(() => {
  const wanted = new Set(ids ? ids.split('\n') : [])
  const unsubscribes = latest.current.filter(provider => wanted.has(provider.id))
   .map(provider => provider.bot!.subscribe(() => { void client.invalidateQueries({ queryKey: chatKey(projectId, provider.id) }) }))
  return () => { for (const unsubscribe of unsubscribes) unsubscribe() }
 }, [client, projectId, ids])
}
