import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TelegramConnectResponse, WebhookReceiver } from '@open-mercato/cezar-api-client'
import { ApiError } from '@/api/client'
import { WebhookForm, telegramUrl, webhookDraft, type WebhookDraft } from './webhook-form'

const urls = {
  Slack: 'https://hooks.slack.com/services/T1/B1/test',
  Discord: `https://discord.com/api/webhooks/123456789012345678/${'a'.repeat(68)}`,
}
afterEach(cleanup)
function mount() {
  const save = vi.fn()
  function Form() {
    const [draft, setDraft] = useState(webhookDraft())
    return <WebhookForm draft={draft} setDraft={setDraft} pending={false} guideHref="https://example.com/guide" save={save} />
  }
  render(<Form />)
  return save
}
describe('chat destination settings', () => {
  it.each(['Slack', 'Discord'] as const)('switches a pasted %s URL and submits without private-network consent', service => {
    const save = mount()
    fireEvent.click(screen.getByLabelText('Allow a receiver on this computer or private network'))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team alerts' } })
    fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: urls[service] } })
    expect(screen.getByRole('status').textContent).not.toContain(urls[service])
    fireEvent.click(screen.getByRole('button', { name: `Use ${service}` }))
    expect(screen.queryByLabelText('Allow a receiver on this computer or private network')).toBeNull()
    expect(screen.getByText(/receivers need no signing key/)).toBeTruthy()
    expect(screen.getByRole('link', { name: `${service} setup guide` })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ format: `${service.toLowerCase()}.v1`, allowLocalNetwork: false, url: urls[service] }))
  })
  it.each(['Slack', 'Discord'] as const)('keeps %s Minimal preview free of titles and questions', service => {
    mount()
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: `${service.toLowerCase()}.v1` } })
    expect(screen.queryByLabelText('Synthetic JSON sample')).toBeNull()
    const preview = screen.getByLabelText(`${service} message sample`)
    expect(preview.textContent).not.toContain('Example generated task title')
    expect(preview.textContent).not.toContain('Which example option')
    fireEvent.change(screen.getByLabelText('Message content'), { target: { value: 'standard' } })
    expect(preview.textContent).toContain('Example generated task title')
    expect(preview.textContent).toContain('Which example option')
    expect(screen.getByText(/Standard posts task titles/).textContent).toContain(service)
  })
  it('keeps custom receivers signed and previews their JSON', () => {
    mount()
    expect(screen.getByLabelText('Destination')).toHaveProperty('value', 'cezar.json.v1')
    expect(screen.getByLabelText('Synthetic JSON sample')).toBeTruthy()
    expect(screen.getByLabelText('Allow a receiver on this computer or private network')).toBeTruthy()
  })
  it('uses the shared 36px control height for every receiver select', () => {
    mount()
    for (const label of ['Destination', 'Events', 'Message content', 'Tasks', 'Waiting and review delay']) {
      expect(screen.getByLabelText(label).classList.contains('h-9'), label).toBe(true)
    }
  })
})

describe('Telegram destination settings', () => {
  const token = `123456789:${'A'.repeat(35)}`
  const url = `https://api.telegram.org/bot${token}/sendMessage`
  it('asks for a bot token and chat ID and submits the sendMessage URL', () => {
    const save = mount()
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'telegram.v1' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team alerts' } })
    expect(screen.getByLabelText('Bot token')).toHaveProperty('type', 'password')
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
    fireEvent.change(screen.getByLabelText('Chat ID'), { target: { value: '-1001234567890' } })
    expect(screen.queryByLabelText('Allow a receiver on this computer or private network')).toBeNull()
    expect(screen.getByRole('link', { name: 'Telegram setup guide' })).toBeTruthy()
    expect(screen.getByLabelText('Telegram message sample')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ format: 'telegram.v1', url, telegramChatId: '-1001234567890', allowLocalNetwork: false }))
  })
  it('requires the chat ID before saving', () => {
    const save = mount()
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'telegram.v1' } })
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team alerts' } })
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
    fireEvent.submit(screen.getByRole('button', { name: 'Save receiver' }).closest('form')!)
    expect(save).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('Telegram chat ID')
  })
  it('reduces a pasted bot URL to its token', () => {
    expect(telegramUrl(`https://api.telegram.org/bot${token}/getUpdates`)).toBe(url)
    expect(telegramUrl(` ${token} `)).toBe(url)
    expect(telegramUrl('')).toBe('')
  })
  it('offers Telegram for a pasted bot URL under a custom receiver', () => {
    mount()
    fireEvent.change(screen.getByLabelText('Receiver URL'), { target: { value: url } })
    fireEvent.click(screen.getByRole('button', { name: 'Use Telegram' }))
    expect(screen.getByLabelText('Destination')).toHaveProperty('value', 'telegram.v1')
  })
})

describe('Telegram chat connection', () => {
  const token = `123456789:${'A'.repeat(35)}`
  const bot = { username: 'cezar_alerts_bot', name: 'Cezar alerts' }
  const group = { id: '-1001234567890', type: 'supergroup' as const, title: 'Ops' }
  function mountTelegram(connect: (input: unknown, signal: AbortSignal) => Promise<TelegramConnectResponse>, receiver?: WebhookReceiver) {
    const save = vi.fn()
    function Form() {
      const [draft, setDraft] = useState<WebhookDraft>({ ...webhookDraft(receiver), format: 'telegram.v1' })
      return <WebhookForm receiver={receiver} draft={draft} setDraft={setDraft} pending={false} guideHref="https://example.com/guide" save={save} connectTelegram={connect} />
    }
    render(<Form />)
    return save
  }
  it('needs a token before connecting', () => {
    mountTelegram(vi.fn())
    expect(screen.getByRole('button', { name: 'Connect chat' })).toHaveProperty('disabled', true)
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
    expect(screen.getByRole('button', { name: 'Connect chat' })).toHaveProperty('disabled', false)
  })
  it('fills the chat ID when the start link is used', async () => {
    const connect = vi.fn(async () => ({ bot, chats: [group], match: group }))
    const save = mountTelegram(connect)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Team alerts' } })
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect chat' }))
    expect(await screen.findByText(/Connected to/)).toBeTruthy()
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ token, code: expect.stringMatching(/^[A-Za-z0-9]{16}$/) }), expect.any(AbortSignal))
    expect(screen.getByLabelText('Chat ID')).toHaveProperty('value', group.id)
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ telegramChatId: group.id }))
  })
  it('shows start links with the one-time code and lets the user pick a known chat', async () => {
    const connect = vi.fn(async () => ({ bot, chats: [group] }))
    mountTelegram(connect)
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect chat' }))
    const start = await screen.findByRole('link', { name: 'Private chat with the bot' })
    const code = (connect.mock.calls[0] as unknown as [{ code: string }])[0].code
    expect(start.getAttribute('href')).toBe(`https://t.me/cezar_alerts_bot?start=${code}`)
    expect(screen.getByRole('link', { name: 'Add the bot to a group' }).getAttribute('href')).toBe(`https://t.me/cezar_alerts_bot?startgroup=${code}`)
    fireEvent.click(screen.getByRole('button', { name: 'Use' }))
    expect(screen.getByLabelText('Chat ID')).toHaveProperty('value', group.id)
    expect(screen.getByText(/Connected to/)).toBeTruthy()
  })
  it('shows the server error', async () => {
    mountTelegram(vi.fn(async () => { throw new Error('Telegram rejected this bot token. Copy it again from @BotFather.') }))
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect chat' }))
    expect((await screen.findByRole('alert')).textContent).toContain('rejected this bot token')
  })
  it('reuses the saved token of an existing receiver', async () => {
    const connect = vi.fn(async () => ({ bot, chats: [], match: group }))
    const receiver = { id: '11111111-1111-4111-8111-111111111111', format: 'telegram.v1', telegramChatId: '1', name: 'Telegram', revision: 3, destination: 'Telegram chat 1', profile: 'minimal', preset: 'attention', events: [], scope: 'main_and_questions', graceSeconds: 180, allowLocalNetwork: false, includeScheduledFailures: false } as unknown as WebhookReceiver
    mountTelegram(connect, receiver)
    expect(screen.getByLabelText('Chat ID')).toHaveProperty('value', '1')
    fireEvent.click(screen.getByRole('button', { name: 'Connect chat' }))
    await screen.findByText(/Connected to/)
    expect(connect).toHaveBeenCalledWith(expect.objectContaining({ receiverId: receiver.id }), expect.any(AbortSignal))
    expect((connect.mock.calls[0] as unknown as [object])[0]).not.toHaveProperty('token')
  })
  it('never carries a typed token into a plain-text URL field', () => {
    mountTelegram(vi.fn())
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'cezar.json.v1' } })
    expect(screen.getByLabelText('Receiver URL')).toHaveProperty('value', '')
  })
  it('waits out a rate-limited first call instead of failing', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const connect = vi.fn()
        .mockRejectedValueOnce(new ApiError(429, 'Another Telegram connection check is already running; try again shortly'))
        .mockResolvedValue({ bot, chats: [group], match: group })
      mountTelegram(connect)
      fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect chat' }))
      await vi.advanceTimersByTimeAsync(3500)
      expect(await screen.findByText(/Connected to/)).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(connect).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
  it('keeps waiting through a dropped poll after the bot is known', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const connect = vi.fn()
        .mockResolvedValueOnce({ bot, chats: [] })
        .mockRejectedValueOnce(new Error('Could not reach Telegram. Check the connection and try again.'))
        .mockResolvedValue({ bot, chats: [group], match: group })
      mountTelegram(connect)
      fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
      fireEvent.click(screen.getByRole('button', { name: 'Connect chat' }))
      await screen.findByRole('link', { name: 'Private chat with the bot' })
      await vi.advanceTimersByTimeAsync(7000)
      expect(await screen.findByText(/Connected to/)).toBeTruthy()
      expect(screen.queryByRole('alert')).toBeNull()
      expect(connect).toHaveBeenCalledTimes(3)
    } finally { vi.useRealTimers() }
  })
})

