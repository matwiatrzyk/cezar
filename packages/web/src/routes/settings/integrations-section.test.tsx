import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { IntegrationsSection } from './integrations-section'

const receiver = (id: string, format: string) => ({
  id, name: id, format, state: 'active', revision: 1, deliveryRevision: 1,
  profile: 'minimal', preset: 'attention', events: [], scope: 'every_task', graceSeconds: 180,
  allowLocalNetwork: false, includeScheduledFailures: false, pendingCount: 0, inFlightCount: 0,
  consecutiveFailures: 0, lastTest: 'success', activationBlocked: false,
})

function mount() {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/health')) return new Response(JSON.stringify({ capabilities: { webhooks: true } }), { status: 200 })
    if (url.includes('/e2e')) return new Response(JSON.stringify({ configFile: 'e2e.config.ts', workflow: true, credentials: [], setup: null }), { status: 200 })
    if (url.includes('/tracker/association')) return new Response(JSON.stringify({ association: { kind: 'jira', connectionId: 'connection-1', externalName: 'Platform' } }), { status: 200 })
    if (url.includes('/tracker/connection')) return new Response(JSON.stringify({ connection: { id: 'connection-1', kind: 'jira' }, demo: false }), { status: 200 })
    if (url.includes('/telegram')) return new Response(JSON.stringify({ available: true, notifications: { available: true }, taskControl: { available: true }, receivers: [], bots: [], grants: [] }), { status: 200 })
    if (url.includes('/webhooks')) return new Response(JSON.stringify({ receivers: [receiver('slack-one', 'slack.v1'), receiver('discord-one', 'discord.v1'), receiver('telegram-one', 'telegram.v1')], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' } }), { status: 200 })
    return new Response('{}', { status: 200 })
  })
  vi.stubGlobal('fetch', fetch)
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  render(<QueryClientProvider client={client}><MemoryRouter><IntegrationsSection /></MemoryRouter></QueryClientProvider>)
  return fetch
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Integrations gallery', () => {
  it('shows tracker, testing and notification tools in one gallery', async () => {
    mount()
    expect(await screen.findByRole('button', { name: 'Configure Jira' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Configure Linear' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Configure TesterArmy e2e' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Configure Slack' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Configure Discord' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Configure Telegram' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Configure ClickUp' })).toBeTruthy()
  })

  it('filters integrations by name and shows an empty state', async () => {
    mount()
    const search = screen.getByRole('textbox', { name: 'Search integrations' })
    fireEvent.change(search, { target: { value: 'click' } })
    expect(screen.getByRole('button', { name: 'Configure ClickUp' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Configure Jira' })).toBeNull()
    fireEvent.change(search, { target: { value: 'does-not-exist' } })
    expect(screen.getByRole('status')).toHaveTextContent('No integrations match “does-not-exist”.')
  })

  it('opens real Telegram configuration and planned ClickUp detail', async () => {
    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Configure Telegram' }))
    const telegram = await screen.findByRole('region', { name: 'Telegram' })
    expect(within(telegram).getByRole('button', { name: 'Connect Telegram' })).toBeTruthy()
    fireEvent.click(within(telegram).getByRole('button', { name: 'All integrations' }))
    fireEvent.click(screen.getByRole('button', { name: 'Configure ClickUp' }))
    expect(await screen.findByRole('region', { name: 'ClickUp' })).toBeTruthy()
    expect(screen.getByText(/planning placeholder/)).toBeTruthy()
  })
})
