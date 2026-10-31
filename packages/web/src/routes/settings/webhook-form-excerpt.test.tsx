import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebhookReceiver } from '@open-mercato/cezar-api-client'
import { WebhookForm, webhookDraft } from './webhook-form'

const token = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
afterEach(cleanup)
function mount({ receiver, telegramControl }: { receiver?: WebhookReceiver; telegramControl?: boolean } = {}) {
  const save = vi.fn()
  function Form() {
    const [draft, setDraft] = useState(webhookDraft(receiver))
    return <WebhookForm receiver={receiver} draft={draft} setDraft={setDraft} pending={false} guideHref="https://example.com/guide" save={save} telegramControl={telegramControl} />
  }
  render(<Form />)
  return save
}
function telegramReceiver(overrides: Partial<WebhookReceiver> = {}): WebhookReceiver {
  return { kind: 'live', id: 'r1', name: 'Phone', destination: 'Telegram chat 42', format: 'telegram.v1', state: 'active', revision: 3, deliveryRevision: 2,
    profile: 'standard', preset: 'attention', events: [], includeScheduledFailures: false, scope: 'main_and_questions', graceSeconds: 180, allowLocalNetwork: false,
    telegramChatId: '42', createdAt: '2026-10-31T12:00:00.000Z', updatedAt: '2026-10-31T12:00:00.000Z', pendingCount: 0, inFlightCount: 0,
    consecutiveFailures: 0, activationBlocked: false, lastTest: 'success', ...overrides }
}
function fillTelegram() {
  fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'telegram.v1' } })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Phone' } })
  fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: token } })
  fireEvent.change(screen.getByLabelText('Chat ID'), { target: { value: '42' } })
}
const consent = /excerpt of the agent’s last message/

describe('agent message excerpt consent', () => {
  it('is offered only with Standard content, warns, and is sent only when ticked', () => {
    const save = mount()
    fillTelegram()
    expect(screen.queryByLabelText(consent)).toBeNull()
    fireEvent.change(screen.getByLabelText('Message content'), { target: { value: 'standard' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save.mock.calls[0]![0]).not.toHaveProperty('includeAgentExcerpt')
    fireEvent.click(screen.getByLabelText(consent))
    expect(screen.getByRole('note').textContent).toMatch(/600 characters of what the agent wrote are sent to your Telegram chat/)
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save.mock.calls[1]![0]).toMatchObject({ includeAgentExcerpt: true, profile: 'standard' })
    fireEvent.change(screen.getByLabelText('Message content'), { target: { value: 'minimal' } })
    expect(screen.queryByLabelText(consent)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save.mock.calls[2]![0]).not.toHaveProperty('includeAgentExcerpt')
  })
  it('restores a saved consent and clears it when unticked', () => {
    const save = mount({ receiver: telegramReceiver({ includeAgentExcerpt: true }) })
    expect(screen.getByLabelText(consent)).toHaveProperty('checked', true)
    fireEvent.click(screen.getByLabelText(consent))
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(save.mock.calls[0]![0]).not.toHaveProperty('includeAgentExcerpt')
  })
})

describe('Telegram grace proposal (spec 2026-10-27-telegram-bidirectional D2)', () => {
  it('proposes 60 s for a new Telegram receiver when task control is available', () => {
    const save = mount({ telegramControl: true })
    expect(screen.getByLabelText('Waiting and review delay')).toHaveProperty('value', '180')
    fillTelegram()
    expect(screen.getByLabelText('Waiting and review delay')).toHaveProperty('value', '60')
    expect(screen.getByText(/Suggested for Telegram with task control/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save.mock.calls[0]![0]).toMatchObject({ format: 'telegram.v1', graceSeconds: 60 })
  })
  it('keeps the user’s own choice and leaves other destinations at the contract default', () => {
    const save = mount({ telegramControl: true })
    fillTelegram()
    fireEvent.change(screen.getByLabelText('Waiting and review delay'), { target: { value: '180' } })
    expect(screen.queryByText(/Suggested for Telegram/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Save receiver' }))
    expect(save.mock.calls[0]![0]).toMatchObject({ graceSeconds: 180 })
    cleanup(); mount({ telegramControl: true })
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'slack.v1' } })
    expect(screen.getByLabelText('Waiting and review delay')).toHaveProperty('value', '180')
  })
  it('keeps 180 without task control, and an edited receiver keeps its stored value', () => {
    mount()
    fillTelegram()
    expect(screen.getByLabelText('Waiting and review delay')).toHaveProperty('value', '180')
    cleanup()
    const save = mount({ receiver: telegramReceiver(), telegramControl: true })
    expect(screen.getByLabelText('Waiting and review delay')).toHaveProperty('value', '180')
    fireEvent.click(screen.getByRole('button', { name: 'Review changes' }))
    expect(save.mock.calls[0]![0]).toMatchObject({ graceSeconds: 180 })
  })
})
