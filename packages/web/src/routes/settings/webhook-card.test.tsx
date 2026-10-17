import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { WebhookCard } from './webhook-card'
const state = vi.hoisted(() => ({ health: { status: 'degraded', reason: 'Retained delivery storage is full' } }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => 'alpha', Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }))
vi.mock('@/hooks/use-webhooks', () => ({ useWebhookSubscription: vi.fn(), useWebhookList: () => ({ data: { receivers: [], webhookHealth: state.health }, isPending: false }) }))
beforeEach(() => { state.health = { status: 'degraded', reason: 'Retained delivery storage is full' } })
afterEach(cleanup)
it('shows service degradation even when no receivers are suspended', () => {
  render(<WebhookCard enabled />)
  expect(screen.getByRole('status').textContent).toContain('Retained delivery storage is full')
})
it('clears current degradation once capacity recovers', () => {
  const view = render(<WebhookCard enabled />)
  state.health = { status: 'ready', reason: '' }
  view.rerender(<WebhookCard enabled />)
  expect(screen.queryByRole('status')).toBeNull()
})
it('does not tell an unsupported platform to enable delivery it cannot run', () => {
  render(<WebhookCard enabled={false} unsupported />)
  expect(screen.getByText(/not supported on this server platform/)).toBeTruthy()
  expect(screen.queryByText(/Turn on webhook delivery/)).toBeNull()
})
