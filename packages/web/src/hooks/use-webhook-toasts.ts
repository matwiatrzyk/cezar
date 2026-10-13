import { useEffect, useRef } from 'react'
import type { WebhookList } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'

/** Observe the panel's existing query, never open another subscription or poll.
 * Keep only one live snapshot and a counter: no accumulating event/revision/receiver IDs.
 * Initial data (including a remount or a different project) is a silent baseline.
 */
export function useWebhookToasts(projectId: string, data: WebhookList | undefined) {
  const previous = useRef<{ projectId: string; data: WebhookList } | undefined>(undefined)
  useEffect(() => {
    if (!data) return
    const before = previous.current
    previous.current = { projectId, data }
    if (!before || before.projectId !== projectId) return
    const states = new Map(before.data.receivers.map(row => [row.id, row.state]))
    for (const row of data.receivers) {
      if (!states.has(row.id) || states.get(row.id) === row.state) continue
      if (row.state === 'active' || row.state === 'disabled') {
        toast(`[${projectId}] Webhook receiver ${row.id} is ${row.state === 'active' ? 'Active' : 'Disabled'}.`)
      }
    }
    const dropped = data.webhookHealth.saturation?.dropped ?? 0
    const oldDropped = before.data.webhookHealth.saturation?.dropped ?? 0
    if (dropped > oldDropped) toast(`[${projectId}] ${dropped - oldDropped} webhook events dropped from the queue. Check webhook health and history.`)
  }, [projectId, data])
}
