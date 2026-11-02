import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { IntegrationsSection } from './integrations-section'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

const E2E_EMPTY = { configFile: null, workflow: false, credentials: [], setup: null }
const REVISION = 'a'.repeat(64)

const TELEGRAM_RECEIVER = {
  id: 'r1', name: 'My bot', format: 'telegram.v1', state: 'active', lastTest: 'success',
  profile: 'standard', preset: 'attention', events: ['task.attention_required'], telegramChatId: '123',
}

function connectedTelegram(health: string = 'polling') {
  return {
    available: true,
    receivers: [{ receiverId: 'r1', botId: '123', inboundRevision: REVISION, state: 'active' }],
    bots: [{ botId: '123', inboundRevision: REVISION, health: { state: health } }],
    grants: [],
  }
}

const EMPTY_TELEGRAM = { available: true, receivers: [], bots: [], grants: [] }

function mockAllFetches({ webhookReceivers = [] as unknown[], telegram }: { webhookReceivers?: unknown[]; telegram?: unknown } = {}) {
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
      const body = telegram ?? (webhookReceivers.length ? connectedTelegram() : EMPTY_TELEGRAM)
      return new Response(JSON.stringify(body), { status: 200 })
    }
    if (url.includes('/webhooks')) {
      return new Response(JSON.stringify({ receivers: webhookReceivers }), { status: 200 })
    }
    return new Response('{}', { status: 200 })
  })
}

const openTelegramTab = () => fireEvent.mouseDown(screen.getByRole('tab', { name: 'Telegram' }), { button: 0, ctrlKey: false })

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

  it('keeps diagnostics reachable and hides access management when no Telegram receiver is connected', async () => {
    vi.stubGlobal('fetch', mockAllFetches())
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    openTelegramTab()
    expect(await screen.findByText('Not set up')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeTruthy()
    expect(await screen.findByText('No Telegram receivers yet')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Bot assignment diagnostics' })).toBeTruthy()
    expect(screen.queryByText('People and permissions')).toBeNull()
    expect(screen.queryByText('Approve a person')).toBeNull()
  })

  it('shows connected status and access management once a bot is connected', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER] }))
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    openTelegramTab()
    expect(await screen.findByText('Connected')).toBeTruthy()
    expect(screen.queryByText('No Telegram receivers yet')).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a chat' })).toBeTruthy()
    expect(await screen.findByText('People and permissions')).toBeTruthy()
    // Diagnostics stay collapsed behind quiet triggers until asked for.
    for (const name of ['Bot assignment diagnostics', 'Recent Telegram actions']) expect(screen.getByRole('button', { name }).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Add a chat' }))
    expect(await screen.findByRole('heading', { name: 'Add a Telegram chat' })).toBeTruthy()
    expect(screen.getByText(/Paste the token of the bot you already connected/)).toBeTruthy()
  })

  it('surfaces a degraded bot health state in the badge instead of counting receivers', async () => {
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram: connectedTelegram('blocked') }))
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    openTelegramTab()
    expect(await screen.findByText('Blocked')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
  })

  it('reads Not set up from bot health, not from a configured webhook receiver', async () => {
    const telegram = { available: true, receivers: [{ receiverId: 'r1', inboundRevision: REVISION, state: 'active' }], bots: [], grants: [] }
    vi.stubGlobal('fetch', mockAllFetches({ webhookReceivers: [TELEGRAM_RECEIVER], telegram }))
    render(<QueryClientProvider client={createQueryClient()}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)

    openTelegramTab()
    expect(await screen.findByText('Not set up')).toBeTruthy()
    expect(screen.queryByText('Connected')).toBeNull()
  })
})
