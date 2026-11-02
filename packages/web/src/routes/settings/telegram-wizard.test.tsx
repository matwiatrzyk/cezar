import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TelegramWizard } from './telegram-wizard'

const mocks = vi.hoisted(() => ({
  create: vi.fn(), test: vi.fn(), activate: vi.fn(), telegramConnect: vi.fn(),
  setup: { begin: vi.fn(), status: vi.fn(), activate: vi.fn(), cancel: vi.fn() },
}))
vi.mock('@/api/client', () => ({ webhookApi: mocks, telegramApi: {}, cez: {}, unwrap: vi.fn() }))
vi.mock('./telegram-inbound', () => ({ defaultSetupApi: mocks.setup }))

afterEach(() => { cleanup(); vi.clearAllMocks() })

const token = `123456789:${'A'.repeat(35)}`
const setupApi = mocks.setup

it('starts with token consent and keeps the bot token out of rendered copy', () => {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={setupApi} />)
  expect(screen.getByRole('heading', { name: 'Connect Telegram' })).toBeTruthy()
  expect(screen.getByLabelText('Bot token')).toBeTruthy()
  expect(screen.getByText(/saved only in this project’s secret store/)).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  expect(document.body.textContent).not.toContain(token)
})

it('requires explicit group visibility acknowledgement before notification activation', () => {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={setupApi} />)
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('checkbox', { name: /Standard sends/ }))
  // Consent is required, so this deliberately remains on the first step.
  expect(screen.getByRole('heading', { name: 'Connect Telegram' })).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: /Standard sends/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(screen.getByRole('heading', { name: 'Connect your Telegram chat' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Activate notifications' })).toHaveProperty('disabled', true)
})
