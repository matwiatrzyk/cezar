import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhooksSection } from './webhooks-section'
const mocks = vi.hoisted(() => ({ enabled: false, project: 'alpha', list: vi.fn(), create: vi.fn() }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ data: { capabilities: { webhooks: mocks.enabled } } }) }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => mocks.project }))
vi.mock('@/api/client', () => ({ webhookApi: { list: mocks.list, create: mocks.create } }))
afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.enabled = false; mocks.project = 'alpha' })
function mount(client = createQueryClient()) { return render(<QueryClientProvider client={client}><MemoryRouter><WebhooksSection /></MemoryRouter></QueryClientProvider>) }
describe('project webhook settings', () => {
  it('explains opt-in in friendly language without creating a receiver query', async () => {
    mount(); expect(screen.getByText('Keep up with your tasks wherever you work')).toBeTruthy()
    expect(screen.getByText(/CEZ_WEBHOOKS=1/)).toBeTruthy(); expect(mocks.list).not.toHaveBeenCalled()
  })
  it('offers full Custom selection and keeps destination secrets out of warnings', async () => {
    mocks.enabled = true; mocks.list.mockResolvedValue({ receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mount(); await screen.findByText(/No receivers yet/); fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
    fireEvent.change(screen.getByLabelText('Events'), { target: { value: 'custom' } })
    expect(screen.getByLabelText('Task finished')).toBeTruthy(); expect(screen.getByLabelText('Task cancelled')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: 'https://hooks.slack.com/services/private-value' } })
    expect(screen.getByText(/Use a JSON relay/)).toBeTruthy()
    expect(screen.getByText(/Use a JSON relay/).textContent).not.toContain('private-value')
  })
  it('never retains a returned key in the shared mutation cache', async () => {
    mocks.enabled = true; mocks.list.mockResolvedValue({ receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mocks.create.mockResolvedValue({ receiver: { id: 'receiver' }, secret: 'EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET' })
    const client = createQueryClient(); mount(client); await screen.findByText(/No receivers yet/)
    fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ops' } })
    fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: 'https://example.com/receiver' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    await screen.findByText('EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET')
    await waitFor(() => expect(client.getMutationCache().getAll().some(item => item.state.status === 'success')).toBe(true))
    expect(JSON.stringify(client.getMutationCache().getAll().map(item => item.state.data))).not.toContain('EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET')
  })
  it('shows a new key once and clears it when the project changes', async () => {
    mocks.enabled = true; mocks.list.mockResolvedValue({ receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
    mocks.create.mockResolvedValue({ receiver: { id: 'receiver' }, secret: 'EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET' })
    const view = mount(); await screen.findByText(/No receivers yet/); fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ops' } })
    fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: 'https://example.com/receiver' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(await screen.findByText('EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET')).toBeTruthy()
    mocks.project = 'beta'; view.rerender(<QueryClientProvider client={createQueryClient()}><MemoryRouter><WebhooksSection /></MemoryRouter></QueryClientProvider>)
    expect(screen.queryByText('EXAMPLE_ONLY_NOT_A_REAL_SIGNING_SECRET')).toBeNull()
  })
})
