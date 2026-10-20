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
        if (row.state === 'active') toast(`${row.name} is now active`)
        else toast(`${row.name} was disabled — open it to repair and test`, { tone: 'danger' })
      }
    }
    const dropped = data.webhookHealth.saturation?.dropped ?? 0
    const oldDropped = before.data.webhookHealth.saturation?.dropped ?? 0
    // The panel is keyed by project, so these toasts only ever describe the project on screen.
    if (dropped > oldDropped) toast(`${dropped - oldDropped === 1 ? '1 webhook event was' : `${dropped - oldDropped} webhook events were`} dropped — the delivery queue is full`, { tone: 'danger' })
  }, [projectId, data])
}
