import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhooksSection } from './webhooks-section'
const api = vi.hoisted(() => ({ list: vi.fn(), deliveries: vi.fn(), activity: vi.fn(), test: vi.fn(), update: vi.fn() }))
vi.mock('@/api/client', () => ({ webhookApi: api, getSelfUpdate: async () => ({ version: 'dev', installKind: 'checkout' }) }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { webhooks: true } } }) }))
const receiver = { kind: 'live', id: 'r', name: 'Alerts', destination: 'https://example.com/', state: 'active', revision: 1, deliveryRevision: 1, profile: 'minimal', preset: 'attention', events: [], scope: 'every_task', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false, pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'none', activationBlocked: false }
function Location() { const navigate = useNavigate(); return <><output data-testid="location">{useLocation().pathname+useLocation().search}</output><button onClick={() => void navigate("/p/beta/settings/webhooks?endpoint=b&tab=activity")}>Switch project</button><button onClick={() => void navigate(-1)}>Browser back</button></> }
function mount(search: string, destination: string) { render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={[destination, '/p/alpha/settings/webhooks'+search]}><WebhooksSection /><Location /></MemoryRouter></QueryClientProvider>) }
beforeEach(() => {
 vi.stubGlobal('EventSource', undefined)
 api.list.mockResolvedValue({ receivers: [receiver], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
 api.deliveries.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
 api.activity.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })
it.each(['/p/beta/settings/webhooks?endpoint=b&tab=activity', '/p/alpha/settings/webhooks?endpoint=r&tab=activity'])('keeps %s when an old edit response arrives', async destination => {
 let resolve!: (value: unknown) => void
 api.update.mockReturnValue(new Promise(r => { resolve = r }))
 mount('?endpoint=r&tab=settings', destination)
 await screen.findByRole('dialog')
 fireEvent.change(screen.getByLabelText('Name'), {target: {value: 'Changed'}})
 fireEvent.click(screen.getByRole('button', {name: 'Review changes'}))
 fireEvent.click(await screen.findByRole('button', {name: 'Confirm'}))
 await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1))
 fireEvent.click(screen.getByText('Browser back'))
 await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(destination))
 await act(async () => { resolve({receiver}); await new Promise(r => setTimeout(r, 30)) })
 expect(screen.getByTestId('location').textContent).toBe(destination)
})
