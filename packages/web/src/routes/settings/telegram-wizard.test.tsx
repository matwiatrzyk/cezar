import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TelegramWizard } from './telegram-wizard'

const revision = 'a'.repeat(64)
const activatedRevision = 'b'.repeat(64)
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
  await waitFor(() => expect(screen.getByRole('link', { name: 'Private chat with the bot' }).getAttribute('href')).toBe('https://t.me/fixture_bot?start=00000000-0000-4000-8000-000000000001'))
  expect(api.begin).toHaveBeenCalledWith('alpha', { token, name: 'Telegram notifications', dedicatedBot: true })
  expect(document.body.textContent).not.toContain(token)
  await waitFor(() => expect(screen.getByText(/Connected as/)).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable task control for this private chat/ }))
  expect(screen.getByText(/No second link is needed/)).toBeTruthy()
  expect(screen.getByText(/agents that run shell commands/)).toBeTruthy()
  for (const label of ['Start tasks', 'Cancel tasks', 'Continue tasks (may incur costs)'])
    expect(screen.getByRole('checkbox', { name: label })).toHaveProperty('checked', false)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Continue tasks (may incur costs)' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Start tasks' }))
  fireEvent.click(screen.getByRole('checkbox', { name: 'Cancel tasks' }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications and task control' }))
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), { expectedRevision: revision, candidateUserId: '456', taskControl: true, permissions: ['respond', 'start', 'cancel', 'continue'] }))
  expect(api.begin).toHaveBeenCalledTimes(1)
  expect(screen.getByText(/Telegram setup is complete/).textContent).toContain('task control is enabled')
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(api.cancel).not.toHaveBeenCalled()
})

it('allows group notifications after Start but requires private comparison for task control', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000002', 'temporary-receiver')).mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000003', 'control-receiver'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Group person', chatType: 'group', chatTitle: 'Ops team' } })
  // Activation creates the chat and moves the bot's revision on; the next begin must use the new one.
  api.activate.mockResolvedValueOnce({ inboundRevision: activatedRevision, receiverId: 'durable-receiver' }).mockResolvedValue({ inboundRevision: 'c'.repeat(64) })
  openWizard()
  await waitFor(() => expect(screen.getByText(/Group “Ops team” · started by Group person/)).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Activate notifications' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), { expectedRevision: revision, candidateUserId: '456', taskControl: false, groupVisibilityAccepted: true }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Telegram notifications are active' })).toBeTruthy())
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person', chatType: 'private', comparisonCode: '123456' } })
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable optional task control/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(api.begin).toHaveBeenNthCalledWith(2, 'alpha', { receiverId: 'durable-receiver', expectedRevision: activatedRevision, dedicatedBot: true, groupVisibilityAccepted: true }))
  await waitFor(() => expect(screen.getByText(/Open the private setup link/)).toBeTruthy())
  const activate = screen.getByRole('button', { name: 'Activate task control' })
  expect(activate).toHaveProperty('disabled', true)
  await waitFor(() => expect(screen.getByText(/Comparison code: 123456/)).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: /compared the code sent privately/ }))
  expect(activate).toHaveProperty('disabled', false)
  fireEvent.click(activate)
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), expect.objectContaining({ taskControl: true, comparisonVerified: true })))
  await waitFor(() => expect(screen.getByText(/Telegram setup is complete/).textContent).toContain('task control is enabled'))
})

it('makes the dedicated-bot consent and unchecked state explicit', () => {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  expect(screen.getByText(/No other application receives its messages/)).toBeTruthy()
  expect(screen.getByText(/must check this to continue/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  expect(screen.getByRole('button', { name: 'Continue' })).toHaveProperty('disabled', false)
})

it('shows a friendly message for an invalid token without echoing the raw code', async () => {
  api.begin.mockRejectedValueOnce(new Error('invalid_token'))
  openWizard()
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(screen.getByRole('alert').textContent).toContain('Telegram rejected this bot token')
  expect(screen.getByRole('alert').textContent).not.toContain('invalid_token')
})

it('shows a friendly message when the person is already paired', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000010'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person' } })
  api.activate.mockRejectedValueOnce(new Error('already_paired'))
  openWizard()
  await waitFor(() => expect(screen.getByText(/Connected as/)).toBeTruthy())
  fireEvent.click(screen.getByRole('checkbox', { name: /Enable task control for this private chat/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications and task control' }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  expect(screen.getByRole('alert').textContent).toContain('already approved for this chat')
  expect(screen.getByRole('alert').textContent).not.toContain('already_paired')
})

it('labels the receiver name field as Notification name and keeps it in the payload', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000020'))
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  expect(screen.queryByLabelText('Bot name')).toBeFalsy()
  fireEvent.change(screen.getByLabelText('Notification name'), { target: { value: 'Ops alerts' } })
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  await waitFor(() => expect(api.begin).toHaveBeenCalledWith('alpha', expect.objectContaining({ name: 'Ops alerts' })))
})

it('moves keyboard focus to the new step on change', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000030'))
  api.status.mockResolvedValue({ status: 'waiting', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision })
  openWizard()
  await waitFor(() => expect(screen.getByText(/Open one of these links in Telegram/)).toBeTruthy())
  await waitFor(() => expect(document.activeElement?.textContent).toContain('Open one of these links in Telegram'))
})

async function reachGroupCandidate(id: string, chatTitle?: string) {
  api.begin.mockResolvedValueOnce(begun(id))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Group person', chatType: 'group', ...(chatTitle ? { chatTitle } : {}) } })
  openWizard()
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /all members of this group/ })).toBeTruthy())
}

it('offers a private link and an Add to a group link built from the same setup code', async () => {
  api.begin.mockResolvedValueOnce(begun('code_abc'))
  api.status.mockResolvedValue({ status: 'waiting', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision })
  openWizard()
  const groupLink = await screen.findByRole('link', { name: 'Add to a group' })
  expect(groupLink.getAttribute('href')).toBe('https://t.me/fixture_bot?startgroup=code_abc')
  expect(screen.getByRole('link', { name: 'Private chat with the bot' }).getAttribute('href')).toBe('https://t.me/fixture_bot?start=code_abc')
  expect(screen.getByText(/Forum groups \(with topics\) are not supported/)).toBeTruthy()
  expect(screen.getByText(/Press Start there/)).toBeTruthy()
})

it('names the group and asks for the visibility consent once Start arrives from a group', async () => {
  await reachGroupCandidate('00000000-0000-4000-8000-000000000040', 'Ops team')
  expect(screen.getByRole('status').textContent).toBe('Group “Ops team” · started by Group person · Telegram ID 456')
  expect(screen.queryByRole('checkbox', { name: /Enable task control for this private chat/ })).toBeNull()
})

it('does not claim task control after ticking it and then skipping', async () => {
  await reachGroupCandidate('00000000-0000-4000-8000-000000000041')
  api.activate.mockResolvedValueOnce({ inboundRevision: activatedRevision, receiverId: 'durable-receiver' })
  fireEvent.click(screen.getByRole('checkbox', { name: /all members of this group/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  fireEvent.click(await screen.findByRole('checkbox', { name: /Enable optional task control/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Skip task control' }))
  const done = await screen.findByText(/Telegram setup is complete/)
  expect(done.textContent).not.toContain('task control is enabled')
  expect(done.textContent).toContain('task control is off')
})

it('sets up notifications only and explains the flag when task control is unavailable', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000042'))
  api.status.mockResolvedValue({ status: 'candidate', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision, candidate: { userId: '456', label: 'Private person', chatType: 'private' } })
  api.activate.mockResolvedValueOnce({ inboundRevision: activatedRevision, receiverId: 'durable-receiver' })
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} taskControlUnavailable="flag_off" />)
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  const control = await screen.findByRole('checkbox', { name: /Enable task control for this private chat/ })
  expect(control).toHaveProperty('disabled', true)
  expect(screen.getByText(/needs CEZ_CHAT_INBOUND=1/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Activate notifications' }))
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('alpha', expect.any(String), { expectedRevision: revision, candidateUserId: '456', taskControl: false }))
  expect(await screen.findByRole('checkbox', { name: /Enable optional task control/ })).toHaveProperty('disabled', true)
})

it.each([
  ['flag_off', /CEZ_CHAT_INBOUND=1/],
  ['webhooks_off', /CEZ_WEBHOOKS=1/],
  ['hosted', /hosted cockpit/],
  ['chat_conflict', /already connected to this bot/],
  ['pairing_limit', /Too many Telegram setups/],
  ['Bot is owned elsewhere or its binding changed.', /connected to another project/],
])('maps the %s setup failure to friendly text', async (message, expected) => {
  api.begin.mockRejectedValueOnce(new Error(message))
  openWizard()
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toMatch(expected)
  if (message.includes('_')) expect(alert.textContent).not.toContain(message)
})

it('shows the token format problem instead of silently disabling Continue', () => {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  const field = screen.getByLabelText('Bot token')
  fireEvent.change(field, { target: { value: 'not-a-token' } })
  expect(screen.getByText(/does not look like a bot token/)).toBeTruthy()
  expect(field.getAttribute('aria-invalid')).toBe('true')
  fireEvent.change(field, { target: { value: token } })
  expect(screen.queryByText(/does not look like a bot token/)).toBeNull()
})

it('proposes a notification name no existing receiver uses', () => {
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} existingNames={['Telegram notifications', 'Telegram notifications 2']} />)
  expect((screen.getByLabelText('Notification name') as HTMLInputElement).value).toBe('Telegram notifications 3')
})

it('describes each step and says Cancel setup before anything is active', async () => {
  api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000043'))
  api.cancel.mockResolvedValueOnce({ cancelled: true })
  api.status.mockResolvedValue({ status: 'waiting', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision })
  render(<TelegramWizard projectId="alpha" open onOpenChange={vi.fn()} setupApi={api} />)
  const first = document.querySelector('[data-slot="dialog-description"]')?.textContent ?? screen.getByText(/created with @BotFather/).textContent
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.click(screen.getByRole('checkbox', { name: /bot is dedicated/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
  expect(await screen.findByText(/Choose the chat that receives notifications/)).toBeTruthy()
  expect(first).not.toContain('Choose the chat')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }))
  expect(api.cancel).toHaveBeenCalledWith('alpha', '00000000-0000-4000-8000-000000000043')
})

it('keeps one live region and does not re-render it when a poll returns the same status', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    api.begin.mockResolvedValueOnce(begun('00000000-0000-4000-8000-000000000044'))
    api.status.mockImplementation(async () => ({ status: 'waiting', receiverId: 'receiver', bot: { id: '123', username: 'fixture_bot' }, inboundRevision: revision }))
    openWizard()
    const region = await screen.findByRole('status')
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(1))
    const observed: MutationRecord[] = []
    const observer = new MutationObserver(records => observed.push(...records))
    observer.observe(region, { childList: true, characterData: true, subtree: true })
    await vi.advanceTimersByTimeAsync(4_100)
    await waitFor(() => expect(api.status).toHaveBeenCalledTimes(3))
    observer.disconnect()
    expect(observed).toHaveLength(0)
    expect(screen.getByRole('status')).toBe(region)
  } finally { vi.useRealTimers() }
})
