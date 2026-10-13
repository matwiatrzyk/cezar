import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhooksSection } from './webhooks-section'
const api = vi.hoisted(() => ({ list: vi.fn(), deliveries: vi.fn(), activity: vi.fn() }))
vi.mock('@/api/client', () => ({ webhookApi: api, getSelfUpdate: async () => ({ version: 'dev', installKind: 'checkout' }) }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { webhooks: true } } }) }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => 'alpha' }))
const receiver = { kind: 'live', id: 'r', name: 'Alerts', destination: 'https://example.com/', state: 'active', revision: 1, deliveryRevision: 1, profile: 'minimal', preset: 'attention', events: [], scope: 'every_task', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false, pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, lastTest: 'none', activationBlocked: false }
function Location() { return <output data-testid="location">{useLocation().search}</output> }
function mount(search: string) { render(<QueryClientProvider client={createQueryClient()}><MemoryRouter initialEntries={['/p/alpha/settings/webhooks'+search]}><WebhooksSection /><Location /></MemoryRouter></QueryClientProvider>) }
beforeEach(() => {
 vi.stubGlobal('EventSource', undefined)
 api.list.mockResolvedValue({ receivers: [receiver], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
 api.deliveries.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
 api.activity.mockResolvedValue({ receiver, items: [], total: 0, hasMore: false, timezone: 'UTC' })
})
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.unstubAllGlobals() })
it('opens the requested Activity tab and updates the URL on tab change and close', async () => {
 mount('?endpoint=r&tab=activity')
 const tab = await screen.findByRole('tab', { name: 'Activity' })
 expect(tab.getAttribute('aria-selected')).toBe('true')
 fireEvent.mouseDown(screen.getByRole('tab', { name: 'Deliveries' }), { button: 0, ctrlKey: false })
 await waitFor(() => expect(screen.getByTestId('location').textContent).toContain('tab=deliveries'))
 fireEvent.click(screen.getByRole('button', { name: 'Close' }))
 await waitFor(() => expect(screen.getByTestId('location').textContent).toBe(''))
})
it('opens settings from a receiver deep link', async () => {
 mount('?endpoint=r&tab=settings')
 expect(await screen.findByRole('dialog')).toBeTruthy()
 expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Alerts')
})
it('resolves retained receiver history directly even outside the initial history page', async () => {
 const old = { kind: 'history', id: 'old', name: 'Old receiver', deletedAt: '2026-10-13T12:00:00Z' }
 api.deliveries.mockResolvedValue({ receiver: old, items: [], total: 0, hasMore: false, timezone: 'UTC' })
 mount('?endpoint=old&tab=deliveries')
 expect(await screen.findByText('Old receiver history')).toBeTruthy()
 expect(api.deliveries).toHaveBeenCalledWith('alpha', 'old')
})
