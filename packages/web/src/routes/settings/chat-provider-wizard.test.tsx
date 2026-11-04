import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatWizard } from './telegram-wizard'
import { telegramDescriptor } from '@/lib/chat-providers/telegram'

const api = vi.hoisted(() => ({ begin: vi.fn(), status: vi.fn(), activate: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/client', () => ({ telegramApi: { setup: api }, webhookApi: {}, cez: {}, unwrap: vi.fn() }))
vi.mock('./telegram-inbound', () => ({ defaultSetupApi: api }))
afterEach(cleanup)
beforeEach(() => {
  vi.resetAllMocks()
  api.cancel.mockResolvedValue(undefined)
  api.begin.mockResolvedValue({ setupId: 'setup', receiverId: 'receiver', deepLink: 'https://example.invalid/setup' })
  api.status.mockResolvedValue({ status: 'candidate', inboundRevision: 'revision', candidate: { userId: 'person', label: 'Person', chatType: 'private' } })
})
// Synthetic descriptor only; no second platform transport is implemented.
const provider = {
  ...telegramDescriptor, id: 'slack' as const, name: 'Fixture Chat', format: 'slack.v1' as const,
  bot: {
    ...telegramDescriptor.bot,
    fields: [{ name: 'token', label: 'Fixture credential', placeholder: 'fixture-', pattern: /^fixture-/, invalid: 'Invalid fixture credential' }],
    credentialHint: 'Fixture credentials', help: { label: 'Fixture console', href: 'https://example.invalid' },
    setupErrorMessages: {
      invalid_token: 'Generate a new credential in the Fixture console.',
      group_ineligible: 'Invite the fixture app to an eligible channel.',
      bot_conflict: 'Release the fixture app from its other workspace.',
    },
    unavailableMessages: { hosted: 'Use the fixture app locally.', unavailable: 'Fixture control is unavailable.' },
  },
}
function open() {
  render(<ChatWizard provider={provider} projectId="p" open onOpenChange={vi.fn()} setupApi={api} />)
}
function start() {
  fireEvent.change(screen.getByLabelText('Fixture credential'), { target: { value: 'fixture-secret' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}
it('uses the descriptor for the default notification name', () => {
  open()
  expect(screen.getByLabelText('Notification name')).toHaveProperty('value', 'Fixture Chat notifications')
})
it('deduplicates the provider name and resets it on reopening', () => {
  const props = { provider, projectId: 'p', onOpenChange: vi.fn(), setupApi: api, existingNames: ['Fixture Chat notifications', ' fixture chat notifications 2 '] }
  const view = render(<ChatWizard {...props} open />)
  expect(screen.getByLabelText('Notification name')).toHaveProperty('value', 'Fixture Chat notifications 3')
  fireEvent.change(screen.getByLabelText('Notification name'), { target: { value: 'Edited' } })
  view.rerender(<ChatWizard {...props} open={false} />)
  view.rerender(<ChatWizard {...props} open />)
  expect(screen.getByLabelText('Notification name')).toHaveProperty('value', 'Fixture Chat notifications 3')
})
it.each(['invalid_token', 'slack_invalid_token', 'SLACK-invalid_token', 'slack invalid_token'])('uses exact descriptor guidance for %s', async code => {
  api.begin.mockRejectedValue(new Error(code))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(provider.bot.setupErrorMessages.invalid_token))
})
it.each(['group_ineligible', 'bot owned elsewhere'])('uses provider guidance for other setup failures: %s', async code => {
  api.begin.mockRejectedValue(new Error(code))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(code === 'group_ineligible' ? provider.bot.setupErrorMessages.group_ineligible : provider.bot.setupErrorMessages.bot_conflict))
})
it('uses provider guidance for polling failures', async () => {
  api.status.mockRejectedValue(new Error('invalid_token'))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(provider.bot.setupErrorMessages.invalid_token))
})
it('uses provider guidance for activation failures', async () => {
  api.activate.mockRejectedValue(new Error('invalid_token'))
  open(); start()
  await waitFor(() => expect(screen.getByText(/Connected as Person/)).toBeTruthy())
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(provider.bot.setupErrorMessages.invalid_token))
})
it.each(['hosted', 'unknown_reason'])('uses provider availability guidance for %s', async reason => {
  render(<ChatWizard provider={provider} projectId="p" open onOpenChange={vi.fn()} setupApi={api} taskControlUnavailable={reason} />)
  start()
  await waitFor(() => expect(screen.getByText(reason === 'hosted' ? provider.bot.unavailableMessages.hosted : provider.bot.unavailableMessages.unavailable)).toBeTruthy())
})
it('recognizes provider-prefixed expired setup errors', async () => {
  api.status.mockRejectedValue(new Error('slack_pairing_expired'))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('This setup link expired. Start again.'))
  expect(screen.getByLabelText('Fixture credential')).toBeTruthy()
})
it('does not echo unknown server details or fall back to Telegram guidance', async () => {
  api.begin.mockRejectedValue(new Error('invalid_token fixture-secret'))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not start Fixture Chat setup.'))
})
it('preserves Telegram default naming and exact credential guidance', async () => {
  api.begin.mockRejectedValue(new Error('telegram_invalid_token'))
  render(<ChatWizard provider={telegramDescriptor} projectId="p" open onOpenChange={vi.fn()} setupApi={api} existingNames={['Telegram notifications']} />)
  expect(screen.getByLabelText('Notification name')).toHaveProperty('value', 'Telegram notifications 2')
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: `123456789:${'A'.repeat(35)}` } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Telegram rejected this bot token. Copy it again from @BotFather and try again.'))
})

it.each(['__proto__', 'constructor', 'toString', 'slack___proto__'])('uses the wizard fallback for inherited message key %s', async code => {
  api.begin.mockRejectedValue(new Error(code))
  open(); start()
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Could not start Fixture Chat setup.'))
})
