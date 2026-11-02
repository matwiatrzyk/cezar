import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { TelegramSetupStatus, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { TelegramSettings as TelegramInboundPanel, setupBlockers, type TelegramSetupApi } from './telegram-inbound'
const mocks = vi.hoisted(() => ({ list: vi.fn(), activity: vi.fn(), permissions: vi.fn(), reset: vi.fn(), disconnect: vi.fn(), bindings: vi.fn(), releaseBinding: vi.fn(), enable: vi.fn(), revoke: vi.fn(), unsubscribe: vi.fn(), subscribe: vi.fn(), listener: undefined as undefined | ((data: unknown) => void) }))
vi.mock('@/api/client', () => ({ telegramApi: mocks }))
vi.mock('@/api/ws', () => ({ subscribeTopic: mocks.subscribe }))
const receiver: WebhookReceiver = { kind: 'live', destination: 'Telegram chat 456', revision: 1, deliveryRevision: 1, includeScheduledFailures: false, scope: 'main_and_questions', graceSeconds: 180, allowLocalNetwork: false, createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z', pendingCount: 0, inFlightCount: 0, consecutiveFailures: 0, activationBlocked: false, id: 'receiver', name: 'My Telegram', format: 'telegram.v1', state: 'active', lastTest: 'success', profile: 'standard', telegramChatId: '456', preset: 'attention', events: [] }
const groupReceiver: WebhookReceiver = { ...receiver, id: 'group', name: 'Team group', telegramChatId: '-123' }
const revision = 'a'.repeat(64)
function mount(available = true, configuredReceiver = receiver, activity: { entries: unknown[]; nextCursor?: string } = { entries: [] }, setupApi?: TelegramSetupApi, listed?: unknown) {
  mocks.list.mockResolvedValue(listed ?? { available, reason: available ? undefined : 'flag_off', receivers: [{ receiverId: configuredReceiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }], grants: [], bots: [] })
  mocks.activity.mockResolvedValue(activity)
  mocks.subscribe.mockImplementation((_topic: string, listener: (data: unknown) => void) => { mocks.listener = listener; return mocks.unsubscribe })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><TelegramInboundPanel projectId="project" receivers={[configuredReceiver]} setupApi={setupApi} /></QueryClientProvider>)
}
afterEach(() => { cleanup(); vi.resetAllMocks(); mocks.listener = undefined })
const setupRevision = 'b'.repeat(64), setupId = '11111111-1111-4111-8111-111111111111'
function setupMocks(status: 'candidate' | 'expired' = 'candidate', candidate: TelegramSetupStatus['candidate'] = { userId: '456', label: 'Ada', username: 'ada', chatType: 'private' }, receiverId = receiver.id) {
  const api: TelegramSetupApi = {
    begin: vi.fn<TelegramSetupApi['begin']>(async () => ({ setupId, receiverId, bot: { id: '123', username: 'cezar_bot' }, expiresAt: Date.now() + 300000, deepLink: 'https://t.me/cezar_bot?start=one-time' })),
    status: vi.fn<TelegramSetupApi['status']>(async () => ({ status, receiverId, bot: { id: '123', username: 'cezar_bot' }, inboundRevision: setupRevision, ...(status === 'candidate' ? { candidate } : {}) })),
    activate: vi.fn<TelegramSetupApi['activate']>(async () => activated),
    cancel: vi.fn<TelegramSetupApi['cancel']>(async () => ({ cancelled: true })),
  }
  return api
}
const activated = { grant: { id: '22222222-2222-4222-8222-222222222222', receiverId: receiver.id, chatId: '456', userId: '456', label: 'Ada', permissions: ['respond' as const], capability: 'task_control' as const, generation: '33333333-3333-4333-8333-333333333333', enableGeneration: '44444444-4444-4444-8444-444444444444', approvedAt: Date.now() }, inboundRevision: setupRevision }
const grant = (receiverId: string, userId = '456') => ({ ...activated.grant, id: `grant-${receiverId}-${userId}`, receiverId, userId })
/** Open the panel and create the link for the only ready receiver: three clicks. */
async function togglePanel() {
  await waitFor(() => expect(screen.queryByText('Loading Telegram settings…')).toBeNull())
}
async function createLink() {
  await togglePanel()
  const create = await screen.findByRole('button', { name: 'Create Telegram link' })
  expect(create).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /This bot is dedicated to this project/ }))
  fireEvent.click(create)
}
it('pairs a private chat in one wizard: choose, link, one Confirm screen, activate', async () => {
  const user = userEvent.setup()
  const api = setupMocks(); mount(true, receiver, { entries: [] }, api)
  await togglePanel()
  await screen.findByRole('button', { name: 'Create Telegram link' })
  // No mode question, no second pairing path, no Notifications-only branch.
  expect(screen.queryAllByRole('radio')).toHaveLength(0)
  expect(screen.queryByRole('button', { name: /Pair person|Replace pairing|Start guided setup/ })).toBeNull()
  expect(document.body.textContent).not.toMatch(/Notifications only|older versions|upgrade/i)
  expect(screen.getByLabelText('Telegram receiver')).toHaveProperty('value', receiver.id)
  fireEvent.click(screen.getByRole('checkbox', { name: /This bot is dedicated to this project/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Create Telegram link' }))
  expect(api.begin).toHaveBeenCalledWith('project', { receiverId: receiver.id, expectedRevision: revision, dedicatedBot: true })
  expect(await screen.findByRole('link', { name: 'Open Telegram' })).toBeTruthy()
  expect(document.body.textContent).not.toContain('987654321:SENTINEL_TOKEN_MUST_NEVER_RENDER_1234567890')
  const heading = await screen.findByRole('heading', { name: 'Confirm task control' })
  expect(document.activeElement).toBe(heading)
  expect(screen.getByText(/pressed Start in @cezar_bot/).textContent).toBe('Ada (@ada) · Telegram ID 456 pressed Start in @cezar_bot.')
  expect(screen.getByRole('checkbox', { name: 'Cancel tasks' })).toHaveProperty('checked', false)
  expect(screen.getByRole('checkbox', { name: 'Continue tasks (may incur costs)' })).toHaveProperty('checked', false)
  expect(screen.getAllByText(/shell commands on this machine/)).toHaveLength(1)
  expect(screen.queryAllByRole('checkbox', { name: /dedicated/ })).toHaveLength(0)
  await user.click(screen.getByRole('checkbox', { name: 'Cancel tasks' }))
  await user.click(screen.getByRole('button', { name: 'Activate task control' }))
  expect(await screen.findByText(/Task control is active for Ada/)).toBeTruthy()
  expect(api.activate).toHaveBeenCalledWith('project', setupId, { expectedRevision: setupRevision, candidateUserId: '456', permissions: ['respond', 'cancel'] })
  expect(screen.queryByRole('button', { name: 'Set up another person' })).toBeNull()
  expect(screen.getByText(/use Add a chat above with the same bot token/)).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }))
  await user.click(screen.getByRole('button', { name: 'Done' }))
  expect(api.cancel).not.toHaveBeenCalled()
})
it('pairs a group member through the same wizard: visibility consent and the comparison code', async () => {
  const api = setupMocks('candidate', { userId: '789', label: 'Grace', chatType: 'private', comparisonCode: '012345' }, groupReceiver.id); mount(true, groupReceiver, { entries: [] }, api)
  await togglePanel()
  const create = await screen.findByRole('button', { name: 'Create Telegram link' })
  expect(screen.getByRole('option', { name: 'Team group (group)' })).toBeTruthy()
  expect(screen.getByText(/new tasks start only from a private-chat receiver\. Forum groups are not supported/)).toBeTruthy()
  fireEvent.click(screen.getByRole('checkbox', { name: /This bot is dedicated to this project/ }))
  expect(create).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /all group members can read project messages/ }))
  fireEvent.click(create)
  expect(api.begin).toHaveBeenCalledWith('project', { receiverId: groupReceiver.id, expectedRevision: revision, dedicatedBot: true, groupVisibilityAccepted: true })
  expect(await screen.findByText('012345')).toBeTruthy()
  const activate = screen.getByRole('button', { name: 'Activate task control' })
  expect(activate).toHaveProperty('disabled', true)
  fireEvent.click(screen.getByRole('checkbox', { name: /I compared this code/ }))
  fireEvent.click(activate)
  await waitFor(() => expect(api.activate).toHaveBeenCalledWith('project', setupId, { expectedRevision: setupRevision, candidateUserId: '789', permissions: ['respond'], comparisonVerified: true }))
  expect(await screen.findByText(/Task control is active for Grace in this group/)).toBeTruthy()
  expect(screen.getByText(/Another member of this group can be approved by running this setup again/)).toBeTruthy()
})
it('cancels the server setup session on every wizard exit so abandons never exhaust pairing slots', async () => {
  for (const exit of ['Cancel setup', 'Not this person', 'Exit setup', 'Try again', 'unmount'] as const) {
    const api = setupMocks()
    if (exit === 'Exit setup' || exit === 'Try again') vi.mocked(api.activate).mockRejectedValue(new Error('pairing_changed'))
    const view = mount(true, receiver, { entries: [] }, api)
    await createLink()
    await screen.findByRole('link', { name: 'Open Telegram' })
    if (exit === 'Cancel setup') fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }))
    else if (exit === 'unmount') view.unmount()
    else {
      await screen.findByRole('heading', { name: 'Confirm task control' })
      if (exit === 'Not this person') fireEvent.click(screen.getByRole('button', { name: 'Not this person' }))
      else {
        fireEvent.click(screen.getByRole('button', { name: 'Activate task control' }))
        fireEvent.click(await screen.findByRole('button', { name: exit }))
      }
    }
    await waitFor(() => expect(api.cancel, exit).toHaveBeenCalledWith('project', setupId))
    expect(api.cancel).toHaveBeenCalledTimes(1)
    if (exit !== 'unmount') view.unmount()
    vi.resetAllMocks()
  }
})
it('moves focus to the activating state before completion', async () => {
  let finish!: (value: Awaited<ReturnType<TelegramSetupApi['activate']>>) => void
  const api = setupMocks()
  vi.mocked(api.activate).mockReturnValue(new Promise(resolve => { finish = resolve }))
  const user = userEvent.setup(); mount(true, receiver, { entries: [] }, api)
  await createLink()
  await user.click(await screen.findByRole('button', { name: 'Activate task control' }))
  expect(document.activeElement?.textContent).toContain('Activating task control')
  finish(activated)
})
it('recovers from an expired setup with a keyboard-reachable retry that keeps the receiver', async () => {
  const user = userEvent.setup()
  const api = setupMocks('expired'); mount(true, receiver, { entries: [] }, api)
  await createLink()
  expect(await screen.findByText(/This setup link expired/)).toBeTruthy()
  const retry = screen.getByRole('button', { name: 'Try again' }); expect(document.activeElement).toBe(retry)
  const loads = mocks.list.mock.calls.length
  await user.keyboard('{Enter}')
  expect(await screen.findByLabelText('Telegram receiver')).toHaveProperty('value', receiver.id)
  expect(screen.getByRole('checkbox', { name: /This bot is dedicated/ })).toHaveProperty('checked', true)
  expect(mocks.list.mock.calls.length).toBeGreaterThan(loads)
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})
it('retries a conflicted setup once with the fresh receiver revision, without a manual refresh', async () => {
  const api = setupMocks(), fresh = 'c'.repeat(64); mount(true, receiver, { entries: [] }, api)
  vi.mocked(api.begin).mockRejectedValueOnce(new Error('conflict'))
  await togglePanel()
  const create = await screen.findByRole('button', { name: 'Create Telegram link' })
  mocks.list.mockResolvedValue({ available: true, receivers: [{ receiverId: receiver.id, inboundRevision: fresh, state: 'disabled' }], grants: [], bots: [] })
  fireEvent.click(screen.getByRole('checkbox', { name: /This bot is dedicated to this project/ }))
  fireEvent.click(create)
  expect(await screen.findByRole('link', { name: 'Open Telegram' })).toBeTruthy()
  expect(api.begin).toHaveBeenCalledTimes(2)
  expect(api.begin).toHaveBeenLastCalledWith('project', { receiverId: receiver.id, expectedRevision: fresh, dedicatedBot: true })
  expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
})
it('retries a conflict only once; a pairing with another bot is replaced only after explicit confirmation', async () => {
  const api = setupMocks(); mount(true, receiver, { entries: [] }, api)
  vi.mocked(api.begin).mockRejectedValue(new Error('conflict'))
  await createLink()
  expect(await screen.findByText(/Telegram settings changed/)).toBeTruthy()
  expect(api.begin).toHaveBeenCalledTimes(2)
  cleanup(); vi.mocked(api.begin).mockReset().mockRejectedValueOnce(new Error('replacement_required'))
    .mockResolvedValue({ setupId, receiverId: receiver.id, bot: { id: '123', username: 'cezar_bot' }, expiresAt: Date.now() + 300000, deepLink: 'https://t.me/cezar_bot?start=x' })
  mount(true, receiver, { entries: [] }, api)
  await createLink()
  expect((await screen.findByRole('alert')).textContent).toMatch(/bot or chat changed.*removes every approved person/)
  expect(api.begin).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Replace pairing and create link' }))
  await waitFor(() => expect(api.begin).toHaveBeenLastCalledWith('project', { receiverId: receiver.id, expectedRevision: revision, dedicatedBot: true, replaceExisting: true }))
  expect(await screen.findByRole('link', { name: 'Open Telegram' })).toBeTruthy()
})
it('re-pairs a suspended private receiver through explicit replacement instead of a dead end', async () => {
  const api = setupMocks()
  mount(true, receiver, { entries: [] }, api, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'suspended', botId: '123' }], grants: [grant(receiver.id)], bots: [] })
  await createLink()
  expect((await screen.findByRole('alert')).textContent).toMatch(/changed since its person was approved.*removes every approved person/)
  expect(api.begin).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Replace pairing and create link' }))
  await waitFor(() => expect(api.begin).toHaveBeenCalledWith('project', { receiverId: receiver.id, expectedRevision: revision, dedicatedBot: true, replaceExisting: true }))
  expect(await screen.findByRole('link', { name: 'Open Telegram' })).toBeTruthy()
})
it('announces validation while begin is pending and ignores its stale completion after cancellation', async () => {
  let finish!: (value: Awaited<ReturnType<TelegramSetupApi['begin']>>) => void
  const api = setupMocks(); vi.mocked(api.begin).mockReturnValue(new Promise(resolve => { finish = resolve }))
  mount(true, receiver, { entries: [] }, api)
  await createLink()
  expect(screen.getByRole('status').textContent).toBe('Checking the saved bot token…')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel setup' }))
  finish({ setupId, receiverId: receiver.id, bot: { id: '123', username: 'cezar_bot' }, expiresAt: Date.now() + 300000, deepLink: 'https://t.me/cezar_bot?start=stale' })
  // The late session is cancelled on the server, not just ignored here.
  await waitFor(() => expect(api.cancel).toHaveBeenCalledWith('project', setupId))
  expect(screen.getByRole('button', { name: 'Create Telegram link' })).toBeTruthy(); expect(screen.queryByRole('link', { name: 'Open Telegram' })).toBeNull()
})
it('lists only the failing conditions of a receiver, each with its fix', async () => {
  expect(setupBlockers(receiver)).toEqual([])
  expect(setupBlockers({ ...receiver, profile: 'minimal', lastTest: 'permanent_failure' })).toEqual(['Send a test and make sure it arrives.', 'Set it up again with Add a chat to use Standard message content.'])
  expect(setupBlockers({ ...receiver, state: 'inactive', preset: 'custom', events: ['task.finished'], telegramChatId: '' })).toEqual([
    'Set this chat up again with Add a chat.', 'Set it up again with Add a chat to include the Needs your input event.', 'Set it up again with Add a chat to verify the chat.'])
  mount(true, { ...receiver, profile: 'minimal' }, { entries: [] }, setupMocks())
  await togglePanel()
  const card = await screen.findByRole('article', { name: 'My Telegram' })
  expect(within(card).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Set it up again with Add a chat to use Standard message content.'])
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
})
it('says how to recover replies a receiver edit suspended', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'suspended', botId: '123' }], bots: [], grants: [grant(receiver.id)] })
  await togglePanel()
  expect(await screen.findByText('Replies are suspended because this receiver changed. Use Add a chat to connect it again, then approve the person again.')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Enable replies' })).toHaveProperty('disabled', false)
})
it('does not offer a paired private receiver again but keeps a paired group open for more members', async () => {
  mocks.list.mockResolvedValue({ available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }, { receiverId: groupReceiver.id, inboundRevision: revision, state: 'active', botId: '123' }],
    bots: [], grants: [grant(receiver.id), grant(groupReceiver.id, '789')] })
  mocks.activity.mockResolvedValue({ entries: [] })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={[receiver, groupReceiver]} setupApi={setupMocks()} /></QueryClientProvider>)
  await togglePanel()
  await screen.findByRole('button', { name: 'Create Telegram link' })
  expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['Choose a receiver', 'Team group (group)'])
  expect(screen.getAllByRole('checkbox', { name: /Allow cancel for Telegram ID/ })).toHaveLength(2)
})
it('asks for group visibility on the card before re-enabling a group receiver', async () => {
  mount(true, groupReceiver, { entries: [] }, undefined, { available: true, receivers: [{ receiverId: groupReceiver.id, inboundRevision: revision, state: 'disabled', botId: '123' }], bots: [], grants: [grant(groupReceiver.id)] })
  mocks.enable.mockResolvedValue({ state: 'active', inboundRevision: revision })
  await togglePanel()
  const card = await screen.findByRole('article', { name: 'Team group' })
  const enable = await within(card).findByRole('button', { name: 'Enable replies' })
  expect(enable).toHaveProperty('disabled', true)
  fireEvent.click(within(card).getByRole('checkbox', { name: /all group members can read project messages/ }))
  fireEvent.click(enable)
  await waitFor(() => expect(mocks.enable).toHaveBeenCalledWith('project', groupReceiver.id, revision, true, true))
})
it('explains how to add a receiver when there are none', async () => {
  mocks.list.mockResolvedValue({ available: true, receivers: [], grants: [], bots: [] }); mocks.activity.mockResolvedValue({ entries: [] })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={[]} setupApi={setupMocks()} /></QueryClientProvider>)
  await togglePanel()
  expect(await screen.findByText(/Use Connect Telegram above to connect a bot and chat/)).toBeTruthy()
  expect(screen.getByText(/optionally enable task control/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
  expect(document.body.textContent).not.toMatch(/receiver below/)
})
it('shows a turned-off flag and subscribes to the websocket only when Telegram is available', async () => {
  mount(false)
  await screen.findByText(/CEZ_CHAT_INBOUND=1/)
  expect(mocks.subscribe).not.toHaveBeenCalled()
  cleanup(); mount(true)
  await waitFor(() => expect(mocks.subscribe).toHaveBeenCalled())
})
it('shows refreshable errors and never approves a candidate without user action', async () => {
  mount(); cleanup(); mocks.list.mockReset().mockRejectedValue(new Error('Unavailable'))
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={[receiver]} /></QueryClientProvider>)
  await togglePanel()
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Telegram is temporarily unavailable. Try again in a moment.')
})

it('requires confirmation before resetting access and sends the displayed bot revision', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [], grants: [], bots: [{ botId: '123', inboundRevision: revision, health: { state: 'blocked' } }] })
  mocks.reset.mockResolvedValue({ reset: true })
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Reset access' }))
  expect(mocks.reset).not.toHaveBeenCalled()
  await screen.findByRole('dialog')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }))
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledWith('project', '123', revision))
})

it('shows orphan diagnostics on demand and explicitly confirms release', async () => {
  mocks.bindings.mockResolvedValue({ bindings: [{ botId: '123', projectId: 'missing-project', orphaned: true, inboundRevision: revision }], truncated: false })
  mocks.releaseBinding.mockResolvedValue({ released: true })
  mount(); await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Release orphaned bot' }))
  expect(mocks.releaseBinding).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }))
  await waitFor(() => expect(mocks.releaseBinding).toHaveBeenCalledWith('123', revision))
})
it('keeps bot reset and assignment diagnostics reachable without outbound receivers', async () => {
  mocks.list.mockResolvedValue({ available: true, receivers: [], grants: [], bots: [{ botId: '123', inboundRevision: revision, health: { state: 'blocked' } }] })
  mocks.activity.mockResolvedValue({ entries: [] })
  mocks.bindings.mockResolvedValue({ bindings: [{ botId: '456', projectId: 'missing-project', orphaned: true, inboundRevision: revision }], truncated: false })
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><TelegramInboundPanel projectId="project" receivers={[]} /></QueryClientProvider>)
  await togglePanel()
  expect(await screen.findByRole('button', { name: 'Reset access' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Diagnostics' }))
  expect(await screen.findByText(/Telegram bot 456/)).toBeTruthy()
})
it('loads older audit entries using the server cursor without losing the first page', async () => {
  const entry = { id: 'new', at: Date.now(), userId: '456', kind: 'answer', state: 'accepted', reason: 'delivered' }
  mount(true, receiver, { entries: [entry], nextCursor: 'older' })
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }))
  await screen.findByText(/delivered/)
  mocks.activity.mockResolvedValue({ entries: [{ ...entry, id: 'old', reason: 'older-result' }] })
  fireEvent.click(await screen.findByRole('button', { name: 'Load older actions' }))
  await screen.findByText(/Done: completed/)
  expect(screen.getByText(/Done: delivered/)).toBeDefined()
  expect(mocks.activity).toHaveBeenLastCalledWith('project', expect.any(AbortSignal), 'older')
  expect(screen.queryByRole('button', { name: 'Load older actions' })).toBeNull()
})
it('shows a bot-wide rejection count without attributing it to a person', async () => {
  mount(); mocks.activity.mockResolvedValue({ entries: [{ id: 'summary', kind: 'rejection_summary', at: 60_000, count: 137, reason: 'unauthorized', state: 'rejected' }] })
  mocks.bindings.mockResolvedValue({ bindings: [], truncated: false })
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }))
  await screen.findByText(/Bot-wide · 137 rejected messages · not paired/)
  expect(screen.queryByText(/undefined/)).toBeNull()
})

it('maps unavailable reasons, empty receivers and bot poll health to human status text', async () => {
  mount(false)
  await togglePanel()
  await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Telegram task control is turned off'))
  cleanup()
  mocks.list.mockResolvedValue({ available: true, receivers: [], grants: [], bots: [{ botId: '123456789', inboundRevision: revision, health: { state: 'backoff', lastSuccessfulPollAt: 1_760_000_000_000 } }] })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><TelegramInboundPanel projectId="project" receivers={[receiver]} /></QueryClientProvider>)
  await togglePanel()
  expect(await screen.findByText('No Telegram receivers yet')).toBeTruthy()
  expect((await screen.findByRole('status')).textContent).toContain('Temporarily retrying')
  expect(screen.getByText(/Last successful poll:/)).toBeTruthy()
})

it('describes activity with the approved person, a short task ID and readable outcomes', async () => {
  const runId = '12345678-abcd-4000-8000-123456789abc', at = Date.now()
  mount(true, receiver, { entries: [
    { id: 'a', at, userId: '456', chatId: '456', runId, kind: 'tasks', state: 'accepted', reason: 'read' },
    { id: 'b', at, userId: '456', chatId: '456', runId, kind: 'continue', state: 'accepted', reason: 'executed' },
    { id: 'c', at, userId: '789', chatId: '456', runId, kind: 'cancel', state: 'rejected', reason: 'permission_denied' },
    { id: 'd', at, userId: '456', chatId: '456', runId, kind: 'task', state: 'accepted', reason: 'task_created' },
    { id: 'e', at, userId: '456', chatId: '456', kind: 'task', state: 'rejected', reason: 'declined' },
    { id: 'g', at, userId: '456', chatId: '456', kind: 'task', state: 'accepted', reason: 'preview' },
    { id: 'f', at, userId: '456', chatId: '456', kind: 'help', state: 'accepted', reason: 'read' },
  ] }, undefined, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }], bots: [],
    grants: [{ id: 'grant', receiverId: receiver.id, chatId: '456', userId: '456', label: 'Ada', permissions: ['respond'], capability: 'task_control' }] })
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Diagnostics' }))
  expect(await screen.findByText(/Ada · Listed tasks · task 12345678 · Done: answered/)).toBeTruthy()
  expect(screen.getByText(/Ada · Continue · task 12345678 · Done: carried out/)).toBeTruthy()
  expect(screen.getByText(/Telegram ID 789 · Cancel · task 12345678 · Refused: no permission for this action/)).toBeTruthy()
  expect(screen.getByText(/Ada · Task request · task 12345678 · Done: task started/)).toBeTruthy()
  expect(screen.getByText(/Ada · Task request · Refused: cancelled before starting/)).toBeTruthy()
  expect(screen.getByText(/Ada · Task request · Done: confirmation sent/)).toBeTruthy()
  expect(screen.queryByText(/Started a task/)).toBeNull()
  expect(screen.getByText(/Ada · Asked for help · Done: answered/)).toBeTruthy()
  expect(screen.queryByText(/unable to complete|123456789abc/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeTruthy()
})
it('shows a reset failure inside the confirmation dialog', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [], grants: [], bots: [{ botId: '123', inboundRevision: revision, health: { state: 'polling' } }] })
  mocks.reset.mockRejectedValue(new Error('bot_busy'))
  await togglePanel()
  fireEvent.click(await screen.findByRole('button', { name: 'Reset access' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm removal' }))
  const dialog = await screen.findByRole('dialog')
  await waitFor(() => expect(dialog.querySelector('[role="alert"]')?.textContent).toBe('The bot is busy finishing another operation. Try again shortly.'))
})

it.each([receiver, groupReceiver])('asks before replacing a changed chat for $name without requiring an existing grant', async configured => {
  const api = setupMocks('candidate', { userId: '456', label: 'Ada', chatType: 'private' }, configured.id)
  vi.mocked(api.begin).mockRejectedValueOnce(new Error('replacement_required'))
  mount(true, configured, { entries: [] }, api)
  await togglePanel()
  const create = await screen.findByRole('button', { name: 'Create Telegram link' })
  fireEvent.click(screen.getByRole('checkbox', { name: /This bot is dedicated to this project/ }))
  const group = configured.telegramChatId!.startsWith('-')
  if (group) fireEvent.click(screen.getByRole('checkbox', { name: /all group members can read project messages/ }))
  fireEvent.click(create)
  expect((await screen.findByRole('alert')).textContent).toMatch(/bot or chat changed/)
  expect(api.begin).toHaveBeenCalledTimes(1)
  expect(vi.mocked(api.begin).mock.calls[0]![1].replaceExisting).toBeUndefined()
  fireEvent.click(screen.getByRole('button', { name: 'Replace pairing and create link' }))
  await waitFor(() => expect(api.begin).toHaveBeenLastCalledWith('project', {
    receiverId: configured.id, expectedRevision: revision, dedicatedBot: true, replaceExisting: true,
    ...(group ? { groupVisibilityAccepted: true } : {}),
  }))
});

it('offers no approval or access-management UI when no bot is connected', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'disabled' }], grants: [], bots: [] })
  await togglePanel()
  expect(screen.queryByText('People and permissions')).toBeNull()
  expect(screen.queryByText('Approve a person')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
})

it('offers no approval for a second receiver of a private chat another receiver already controls', async () => {
  const notifications = { ...receiver, id: 'notifications', name: 'Old notifications' }
  mocks.list.mockResolvedValue({ available: true, receivers: [
    { receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' },
    { receiverId: notifications.id, inboundRevision: revision, state: 'disabled', botId: '123' },
  ], grants: [grant(receiver.id)], bots: [] })
  mocks.activity.mockResolvedValue({ entries: [] })
  mocks.subscribe.mockImplementation(() => mocks.unsubscribe)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><TelegramInboundPanel projectId="project" receivers={[receiver, notifications]} setupApi={setupMocks()} /></QueryClientProvider>)
  await togglePanel()
  const card = await screen.findByRole('article', { name: 'Old notifications' })
  expect(within(card).getByText('This chat already has task control through My Telegram. This receiver only sends notifications.')).toBeTruthy()
  expect(screen.queryByText('Approve a person')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
})
it('does not prompt for another approval after a private chat is already approved', async () => {
  mount(true, receiver, { entries: [] }, undefined, { available: true, receivers: [{ receiverId: receiver.id, inboundRevision: revision, state: 'active', botId: '123' }], grants: [grant(receiver.id)], bots: [] })
  await togglePanel()
  // The approved person is listed with their permissions; nothing asks for another approval.
  expect(await screen.findByText('People and permissions')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Revoke access' })).toBeTruthy()
  expect(screen.queryByText('Approve a person')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Create Telegram link' })).toBeNull()
})

it('clarifies that an already-approved person needs no further approval', async () => {
  const api = setupMocks()
  vi.mocked(api.activate).mockRejectedValue(new Error('already_paired'))
  mount(true, receiver, { entries: [] }, api)
  await createLink()
  await screen.findByRole('link', { name: 'Open Telegram' })
  await screen.findByRole('heading', { name: 'Confirm task control' })
  fireEvent.click(screen.getByRole('button', { name: 'Activate task control' }))
  expect(await screen.findByText('This person is already approved for this receiver, so no further approval is needed.')).toBeTruthy()
});
