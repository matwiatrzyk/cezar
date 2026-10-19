import { useEffect, useRef } from 'react'
import { toast } from '@/components/ui/toaster'
import { useQuery } from '@tanstack/react-query'
import type { WebhookReceiver } from '@open-mercato/cezar-api-client'
import { webhookApi } from '@/api/client'
import { webhookKey } from '@/hooks/use-webhooks'
import { Button } from '@/components/ui/button'
// Destination-policy refusals (destination.ts codes): nothing was sent, and the same configuration is refused again.
const policyHints: Record<string, string> = {
  local_consent_required: 'This address is on this computer or a private network. Edit the receiver and turn on “Allow a receiver on this computer or private network”.',
  server_port: 'This address points at the cezar server itself. Use your receiver\'s own port.',
  https_required: 'This server only sends to HTTPS receivers. Use an https:// URL.',
  public_destination_required: 'This server only sends to public receivers. Use a publicly reachable HTTPS URL.',
  metadata_hostname: 'Cloud metadata hostnames are never allowed as receivers.',
  denied_address: 'The receiver resolves to an address that is never allowed.',
  mixed_dns: 'The receiver hostname resolves to both public and private addresses. Use a hostname with one kind of address.',
  invalid_dns: 'The receiver hostname did not resolve to a usable address.',
  dns_not_found: 'The receiver hostname does not resolve. Check the URL.',
  invalid_url: 'The receiver URL is not allowed. Use a plain http(s) URL without credentials or a fragment.',
}
export type PendingWebhookTest = { deliveryId: string; receiverId: string; initialState: WebhookReceiver['state']; deliveryRevision: number }
export function WebhookTestFeedback({ projectId, test, openHistory }: { projectId: string; test: PendingWebhookTest; openHistory: (receiverId: string) => void }) {
  const result = useQuery({ queryKey: [...webhookKey(projectId), 'test-result', test.receiverId, test.deliveryId], queryFn: () => webhookApi.deliveries(projectId, test.receiverId), retry: false })
  const row = result.data?.items.find(item => item.deliveryId === test.deliveryId)
  const receiver = result.data?.receiver
  const finished = row && ['delivered', 'failed', 'cancelled', 'superseded', 'dropped'].includes(row.status)
  // Only the current explicit test is retained; query refreshes cannot repeat its toast.
  const announced = useRef<string | undefined>(undefined)
  const terminal = finished ? row.status : undefined
  const unknown = row?.reason === 'outcome_unknown'
  useEffect(() => {
    const key = `${projectId}:${test.deliveryId}`
    if (!terminal || announced.current === key) return
    announced.current = key
    // No server reason, response, URL, receiver name or signing material enters the toast.
    toast(`[${projectId}] Webhook test ${unknown ? 'outcome unknown' : terminal}. Check test history for details.`)
  }, [projectId, test.deliveryId, terminal, unknown])
  const message = result.error ? 'Test result is currently unavailable. Check retained history.' : result.data && !row ? 'Test accepted. Its result is not in the latest history page; open history for older results.' : !finished ? 'Test accepted; waiting for its delivery result.'
    : row.reason === 'outcome_unknown' ? 'The test result is unknown. Check the receiver before sending another test; the first attempt may have arrived.'
    : row.status === 'delivered' ? `Test delivered. Current receiver state: ${receiver?.kind === 'live' ? receiver.state : 'deleted'}.`
    : `Test ${row.status.replaceAll('_', ' ')}${row.reason ? ` (${row.reason.replaceAll('_', ' ')})` : ''}.`
  const hint = !finished || row.status === 'delivered' || row.reason === 'outcome_unknown' ? undefined
    : row.reason === 'timeout' || row.reason === 'connection_failed' ? 'Check that your receiver is reachable and responds within ten seconds.'
    : /^http_(401|403)$/.test(row.reason ?? '') ? 'Check receiver authentication and the signing key installed in its verifier.'
    : row.reason === 'http_404' || row.reason === 'http_410' ? 'Check the receiver URL and whether its endpoint is still enabled.'
    : policyHints[row.reason ?? ''] ? `${policyHints[row.reason!]} Activation is blocked until a test of this configuration succeeds.`
    : 'Check the receiver and its network policy before sending a new test. This test will not retry automatically.'
  return <div role="status" className="space-y-2 rounded border p-3 text-sm"><p>Test {test.deliveryId}</p><p>{message}</p>{hint && <p>{hint}</p>}<Button variant="outline" onClick={() => openHistory(test.receiverId)}>View test history</Button></div>
}
