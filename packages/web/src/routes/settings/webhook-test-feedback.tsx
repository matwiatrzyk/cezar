import { useQuery } from '@tanstack/react-query'
import type { WebhookReceiver } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { webhookKey } from '@/hooks/use-webhooks'
import { Button } from '@/components/ui/button'
export type PendingWebhookTest = { deliveryId: string; receiverId: string; initialState: WebhookReceiver['state']; deliveryRevision: number }
export function WebhookTestFeedback({ projectId, test, openHistory }: { projectId: string; test: PendingWebhookTest; openHistory: (receiverId: string) => void }) {
  const result = useQuery({ queryKey: [...webhookKey(projectId), 'test-result', test.receiverId, test.deliveryId], queryFn: () => webhookApi.deliveries(projectId, test.receiverId), retry: false })
  const row = result.data?.items.find(item => item.deliveryId === test.deliveryId)
  const receiver = result.data?.receiver
  const recovered = row?.status === 'delivered' && test.initialState === 'suspended' && receiver?.kind === 'live' && receiver.state === 'active' && receiver.deliveryRevision === test.deliveryRevision
  const finished = row && ['delivered', 'failed', 'cancelled', 'superseded', 'dropped'].includes(row.status)
  const message = result.error ? 'Test result is currently unavailable. Check retained history.' : result.data && !row ? 'Test accepted. Its result is not in the latest history page; open history for older results.' : !finished ? 'Test accepted; waiting for its delivery result.'
    : row.reason === 'outcome_unknown' ? 'The test result is unknown. Check the receiver before sending another test; the first attempt may have arrived.'
    : recovered ? 'Test delivered. Receiver recovered to Active; eligible pending deliveries can resume.'
    : row.status === 'delivered' ? `Test delivered. Current receiver state: ${receiver?.kind === 'live' ? receiver.state : 'deleted'}.`
    : `Test ${row.status.replaceAll('_', ' ')}${row.reason ? ` (${row.reason.replaceAll('_', ' ')})` : ''}.`
  const hint = !finished || row.status === 'delivered' || row.reason === 'outcome_unknown' ? undefined
    : row.reason === 'timeout' || row.reason === 'connection_failed' ? 'Check that your receiver is reachable and responds within ten seconds.'
    : /^http_(401|403)$/.test(row.reason ?? '') ? 'Check receiver authentication and the signing key installed in its verifier.'
    : row.reason === 'http_404' || row.reason === 'http_410' ? 'Check the receiver URL and whether its endpoint is still enabled.'
    : 'Check the receiver and its network policy before sending a new test. This test will not retry automatically.'
  return <div role="status" className="space-y-2 rounded border p-3 text-sm"><p>Test {test.deliveryId}</p><p>{message}</p>{hint && <p>{hint}</p>}<Button variant="outline" onClick={() => openHistory(test.receiverId)}>View test history</Button></div>
}
