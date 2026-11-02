import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TelegramWizard } from './telegram-wizard'

const revision = 'a'.repeat(64)
const mocks = vi.hoisted(() => ({ begin: vi.fn(), status: vi.fn(), activate: vi.fn(), cancel: vi.fn() }))
vi.mock('@/api/client', () => ({ telegramApi: { setup: mocks }, webhookApi: {}, cez: {}, unwrap: vi.fn() }))
vi.mock('./telegram-inbound', () => ({ defaultSetupApi: mocks }))

afterEach(() => { cleanup(); vi.clearAllMocks() })
const token = `123456789:${'A'.repeat(35)}`
const api = mocks
const begun = (id: string, receiverId = 'receiver') => ({ setupId: id, receiverId, bot: { id: '123', username: 'fixture_bot' }, expiresAt: 1, deepLink: `https://t.me/fixture_bot?start=${id}` })

function openWizard() {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
}

it('starts token-led setup, shows the deep link, polls and activates private notifications', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000001'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person' } })
  api.activate.mockResolvedValue({ inboundRevision: revision })
  openWizard()
  await waitFor(() => expect(screen.getByRole('link', { name: /t\.me\/fixture_bot/ })).toBeTruthy())
  expect(api.begin).toHaveBeenCalledWith('alpha', { token, name: 'Telegram notifications', dedicatedBot: true })
  expect(document.body.textContent).not.toContain(token)
  await waitFor(() => expect(screen.getByText(/Connected as/)).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: /uses this first Telegram identity/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications and task control' }))
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), { expectedRevision: revision, candidateUserId: '456', taskControl: true, permissions: ['respond'] }))
  expect(api.begin).toHaveBeenCalledTimes(1)
  expect(screen.getByText(/Telegram setup is complete/)).toBeTruthy()
})

it('allows group notifications after Start but requires private comparison for task control', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000002', 'temporary-receiver')).mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000003', 'control-receiver'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Group person', chatType: 'group' } })
  api.activate.mockResolvedValue({ inboundRevision: revision, receiverId: 'durable-receiver' })
  openWizard()
  await waitFor(() => expect(screen.getByText(/Connected as/)).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Activate notifications' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Telegram notifications are active' })).toBeTruthy())
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person', chatType: 'private', comparisonCode: '123456' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable optional task control/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(api.begin).toHaveBeenNthCalledWith(2, 'alpha', expect.objectContaining({ receiverId: 'durable-receiver' })))
  await waitFor(() => expect(screen.getByText(/Open the private setup link/)).toBeTruthy())
  const activate = screen.getByRole('button', { name: 'Activate task control' })
  expect(activate).toHaveProperty('disabled', true)
  await waitFor(() => expect(screen.getByText(/Comparison code: 123456/)).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: /compared the code sent privately/ }))
  expect(activate).toHaveProperty('disabled', false)
  fireEvent.click(activate)
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), expect.objectContaining({ taskControl: true, comparisonVerified: true })))
})
