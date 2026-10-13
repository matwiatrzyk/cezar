import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhookTestFeedback } from './webhook-test-feedback'
const api = vi.hoisted(() => ({ deliveries: vi.fn() }))
vi.mock('@/api/client', () => ({ webhookApi: api }))
afterEach(() => { cleanup(); vi.clearAllMocks() })
function mount(state: string, status: string, reason?: string) {
 api.deliveries.mockResolvedValue({ items: [{ deliveryId: 'test1', status, reason }], receiver: { id: 'r', kind: 'live', state, deliveryRevision: 2 } })
 const open = vi.fn()
 render(<QueryClientProvider client={createQueryClient()}><WebhookTestFeedback projectId="alpha" test={{ deliveryId: 'test1', receiverId: 'r', initialState: 'suspended', deliveryRevision: 2 }} openHistory={open} /></QueryClientProvider>)
 return open
}
it('identifies the completed test and confirms only committed recovery', async () => {
 const open = mount('active', 'delivered')
 expect(await screen.findByText(/Test delivered. Receiver recovered to Active/)).toBeTruthy()
 expect(screen.getByText(/test1/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button', { name: 'View test history' })); expect(open).toHaveBeenCalledWith('r')
})
it('does not claim recovery after receiver was paused', async () => {
 mount('paused', 'delivered')
 expect(await screen.findByText(/Test delivered. Current receiver state: paused/)).toBeTruthy()
 expect(screen.queryByText(/recovered to Active/)).toBeNull()
})
it('explains an uncertain test without prompting an automatic resend', async () => {
 mount('suspended', 'failed', 'outcome_unknown')
 expect(await screen.findByText(/result is unknown/)).toBeTruthy()
 expect(screen.getByText(/Check the receiver before sending another test/)).toBeTruthy()
})
