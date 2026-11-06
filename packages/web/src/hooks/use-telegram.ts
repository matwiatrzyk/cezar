import type { ChatProviderDescriptor } from '@/lib/chat-providers'
import { useEffect } from 'react'
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
