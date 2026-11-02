import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { IntegrationsSection } from './integrations-section'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const E2E_EMPTY = { configFile: null, workflow: false, credentials: [], setup: null }

const TELEGRAM_RECEIVER = {
  id: 'r1', name: 'My bot', format: 'telegram.v1', state: 'active', lastTest: 'success',
  profile: 'standard', preset: 'attention', events: ['task.attention_required'], telegramChatId: '123',
}

function mockAllFetches({ webhookReceivers = [] as unknown[] } = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/e2e')) {
      return new Response(JSON.stringify(E2E_EMPTY), { status: 200 })
    }
    if (url.includes('/health')) {
      return new Response(JSON.stringify({ version: '1.0.0', capabilities: { webhooks: true } }), { status: 200 })
    }
    if (url.includes('/telegram/activity')) {
      return new Response(JSON.stringify({ entries: [], nextCursor: undefined }), { status: 200 })
    }
    if (url.includes('/telegram')) {
      const receivers = webhookReceivers.length ? [{ receiverId: 'r1', state: 'active', inboundRevision: 'v1' }] : []
      return new Response(JSON.stringify({ available: true, receivers, bots: [], grants: [] }), { status: 200 })
    }
    if (url.includes('/webhooks')) {
      return new Response(JSON.stringify({ receivers: webhookReceivers }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

describe('External integrations', () => {
  it('opens on the Test frameworks tab with the TesterArmy e2e card', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)
    expect(screen.getByRole('tab', { name: 'Test frameworks' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('heading', { name: 'TesterArmy e2e' })).toBeTruthy()
  })

  it('renders Test frameworks tab first and Telegram tab second', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)
    const tabs = screen.getAllByRole('tab')
    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.textContent).toBe('Test frameworks')
    expect(tabs[1]?.textContent).toBe('Telegram')
  })

  it('does not render a separate Telegram task-control entry point', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    await screen.findByRole('heading', { name: 'TesterArmy e2e' })
    expect(screen.getByRole('tab', { name: 'Telegram' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Two-way Telegram' })).toBeNull()
  })

  it('shows Telegram content only in Telegram tab, not in Test frameworks tab', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    expect(screen.getByRole('tab', { name: 'Test frameworks' }).getAttribute('aria-selected')).toBe('true')
    expect(await screen.findByRole('heading', { name: 'TesterArmy e2e' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Telegram' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect Telegram' })).toBeNull()
  })

  it('shows an empty state and no access management when no Telegram receiver is connected', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Telegram' }), { button: 0, ctrlKey: false })
    expect(await screen.findByText('Not set up')).toBeTruthy()
    expect(await screen.findByText('No Telegram receiver connected')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeTruthy()
    expect(screen.queryByText('Recent Telegram actions')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Bot assignment diagnostics' })).toBeNull()
  })

  it('shows access management once a Telegram receiver is connected', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER] }))
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    fireEvent.mouseDown(screen.getByRole('tab', { name: 'Telegram' }), { button: 0, ctrlKey: false })
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(screen.queryByText('No Telegram receiver connected')).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect another bot' })).toBeTruthy()
    expect(await screen.findByText('Recent Telegram actions')).toBeTruthy()
  })
})
