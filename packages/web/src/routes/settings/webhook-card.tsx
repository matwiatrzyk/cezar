import { Link, useActiveProjectId } from '@/lib/project-router'
import { useWebhookList, useWebhookSubscription } from '@/hooks/use-webhooks'
export function WebhookCard({ enabled }: { enabled: boolean }) {
  const projectId = useActiveProjectId() ?? 'default'
  const list = useWebhookList(projectId, enabled)
  useWebhookSubscription(projectId, enabled)
  const rows = list.data?.receivers ?? []
  return <section className="space-y-2 rounded-lg border p-4 text-sm"><h3 className="font-medium">Webhooks</h3>
    {!enabled ? <p>Optional task updates to your own receiver. Turn on webhook delivery to connect a chat relay.</p> : list.isPending ? <p>Loading delivery status…</p> : list.error ? <p>Delivery status unavailable — open Webhooks for details.</p> : <p>{rows.filter(row => row.state === 'active').length} active · {rows.filter(row => row.state === 'paused').length} paused · {rows.filter(row => ['suspended', 'disabled'].includes(row.state)).length} need attention · {rows.reduce((total, row) => total + row.pendingCount, 0)} pending deliveries</p>}
    {enabled && !list.error && list.data?.webhookHealth && ['degraded', 'unavailable'].includes(list.data.webhookHealth.status) && <p role="status" className="text-warning">{list.data.webhookHealth.reason || 'Webhook delivery needs attention. Open Webhooks for details.'}</p>}
    <Link className="underline" to="/settings/webhooks">Manage webhooks</Link>
  </section>
}
