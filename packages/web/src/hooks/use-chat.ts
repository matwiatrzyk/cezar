import type { ChatProviderDescriptor } from '@/lib/chat-providers'
import type { HealthResponse } from '@open-mercato/cezar-api-client'
import { queryKeys } from '@/api/queries'
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export const chatKey = (projectId: string, providerId: string) => [projectId, `${providerId}-inbound`] as const
export function useChatSubscription(projectId: string, enabled: boolean, provider: ChatProviderDescriptor) {
 const client = useQueryClient()
 useEffect(() => {
  if (!enabled || client.getQueryData<HealthResponse>(queryKeys.health)?.capabilities?.localHandoff !== true) return
  return provider.bot.subscribe(() => { void client.invalidateQueries({ queryKey: chatKey(projectId, provider.id) }) })
 }, [client, projectId, enabled, provider])
}

/** One subscription per bot provider for views that list several (the integrations gallery). Keyed by
 *  provider ids, so a re-render with the same providers keeps its subscriptions. */
export function useChatSubscriptions(projectId: string, providers: readonly ChatProviderDescriptor[]) {
 const client = useQueryClient()
 const ids = providers.map(provider => provider.id).join('\n')
 const latest = useRef(providers)
 useEffect(() => { latest.current = providers })
 useEffect(() => {
  const wanted = new Set(ids ? ids.split('\n') : [])
  if (client.getQueryData<HealthResponse>(queryKeys.health)?.capabilities?.localHandoff !== true) return
  const unsubscribes = latest.current.filter(provider => wanted.has(provider.id))
   .map(provider => provider.bot.subscribe(() => { void client.invalidateQueries({ queryKey: chatKey(projectId, provider.id) }) }))
  return () => { for (const unsubscribe of unsubscribes) unsubscribe() }
 }, [client, projectId, ids])
}
