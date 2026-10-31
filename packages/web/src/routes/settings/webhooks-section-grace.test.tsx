import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { WebhooksSection } from './webhooks-section'

const mocks = vi.hoisted(() => ({ list: vi.fn(), telegramList: vi.fn() }))
vi.mock('@/api/queries', () => ({ useHealth: () => ({ isError: false, data: { capabilities: { webhooks: true } } }) }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => 'alpha' }))
vi.mock('@/api/client', async importOriginal => ({ ...(await importOriginal<typeof import('@/api/client')>()), getSelfUpdate: vi.fn().mockResolvedValue({ version: '0.15.0', installKind: 'checkout' }),
  webhookApi: { list: mocks.list }, telegramApi: { list: mocks.telegramList } }))
beforeEach(() => {
  vi.stubGlobal('EventSource', undefined); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network request') }))
  mocks.list.mockResolvedValue({ receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } })
})
afterEach(() => { vi.unstubAllGlobals(); cleanup(); vi.clearAllMocks() })
const mount = () => render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><WebhooksSection /></MemoryRouter></QueryClientProvider>)

describe('Telegram grace proposal in Add receiver', () => {
  it.each([[true, '60'], [false, '180']] as const)('reads task-control availability %s only for a new Telegram receiver', async (available, expected) => {
    mocks.telegramList.mockResolvedValue({ available, ...(available ? {} : { reason: 'flag_off' }), receivers: [], bots: [] })
    mount()
    await screen.findByText(/Add a Telegram receiver first/)
    fireEvent.click(screen.getByRole('button', { name: 'Add receiver' }))
    expect(mocks.telegramList).not.toHaveBeenCalled()
    fireEvent.change(await screen.findByLabelText('Destination'), { target: { value: 'telegram.v1' } })
    await waitFor(() => expect(mocks.telegramList).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByLabelText('Waiting and review delay')).toHaveProperty('value', expected))
  })
})
