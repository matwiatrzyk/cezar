import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
test('one guided wizard pairs a fresh private receiver and a group member; /task, permissions, disable and revoke using simulated Telegram', async ({ app, screen }) => {
  await app.open('/p/default/settings/webhooks')
  // A fresh private receiver: form, Send test, Activate.
  await screen.getByRole('button', 'Add receiver').tap()
  await screen.getByLabel('Destination').selectOption({ value: 'telegram.v1' })
  await screen.getByLabel('Name').fill('Telegram inbound fixture')
  await screen.getByLabel('Bot token').fill(`123456:${'x'.repeat(35)}`)
  await screen.getByLabel('Chat ID').fill('456')
  await screen.getByLabel('Message content').selectOption({ value: 'standard' })
  await screen.getByRole('button', 'Save receiver').tap()
  await expect(screen.getByRole('dialog')).toHaveCount(0)
  const card = screen.getByRole('article').filter({ hasText: 'Telegram inbound fixture' }).first()
  await card.getByRole('button', 'Send test').tap()
  await expect(card).toContainText('Last test: passed')
  await card.getByRole('button', 'Activate').tap()
  await screen.getByLabel('I understand Standard sends task titles, questions and error text to this receiver.').check()
  await screen.getByRole('button', 'Confirm').tap()
  await expect(card.getByRole('button', 'Pause')).toBeVisible()

  // One wizard: choose the receiver, acknowledge the dedicated bot, open the link, confirm, activate.
  await screen.getByRole('button', 'Two-way Telegram').tap()
  await expect(screen.getByRole('radio')).toHaveCount(0)
  await expect(screen.getByRole('button', 'Pair person')).toHaveCount(0)
  await screen.getByRole('combobox', 'Telegram receiver').selectOption({ label: 'Telegram inbound fixture' })
  await expect(screen.getByRole('button', 'Create Telegram link')).toBeDisabled()
  await screen.getByRole('checkbox', 'This bot is dedicated to this project: no other application receives its messages.').check()
  await screen.getByRole('button', 'Create Telegram link').tap()
  await expect(screen.getByRole('heading', 'Confirm task control')).toBeVisible()
  await expect(screen.getByText(/Telegram ID 456 pressed Start in @fixture_bot/)).toBeVisible()
  await expect(screen.getByRole('checkbox', 'Cancel tasks')).not.toBeChecked()
  await screen.getByRole('button', 'Activate task control').tap()
  await expect(screen.getByText(/Task control is active for Fixture person\./)).toBeVisible()
  await expect(screen.getByText(/add another Telegram receiver for their private chat/)).toBeVisible()
  await screen.getByRole('button', 'Done').tap()
  const privateCard = screen.getByRole('article', 'Telegram inbound fixture')
  await expect(privateCard.getByRole('button', 'Disable replies')).toBeVisible()
  if (!app.baseUrl) throw new Error('Expected the disposable Telegram fixture server URL')
  const base = app.baseUrl.replace(/\/$/, '')
  let telegramRunId = ''
  await expect.poll(async () => {
    const response = await fetch(`${base}/api/v1/runs`)
    const runs = await response.json() as Array<{ id: string; task?: string; status?: string }>
    const run = runs.find(row => row.task?.includes('deterministic Telegram fixture'))
    telegramRunId = run?.id ?? ''
    return run?.status ?? ''
  }).toBe('done')
  // Only the confirmed /task started work: the bare text before it got help, not a task.
  const allRuns = await fetch(`${base}/api/v1/runs`).then(response => response.json()) as Array<{ task?: string }>
  expect(allRuns.filter(row => row.task?.includes('deterministic Telegram fixture'))).toHaveLength(1)
  expect(allRuns.some(row => row.task?.includes('Bare text must never start'))).toBe(false)
  const telegramRun = await fetch(`${base}/api/v1/runs/${telegramRunId}`).then(response => response.json()) as { telegramSource?: { id?: string; state?: string; chatId?: string; userId?: string; botId?: string } }
  // The run carries provenance only; settlement lives in the inbound state, not on the run.
  expect(telegramRun.telegramSource?.id).toEqual(expect.any(String))
  expect(telegramRun.telegramSource?.state).toBeUndefined()
  expect(telegramRun.telegramSource?.chatId).toBeUndefined()
  expect(telegramRun.telegramSource?.userId).toBeUndefined()
  expect(telegramRun.telegramSource?.botId).toBeUndefined()
  await privateCard.getByRole('button', 'Disable replies').tap()
  await expect(privateCard.getByRole('button', 'Enable replies')).toBeVisible()
  await privateCard.getByRole('button', 'Revoke access').tap()
  await screen.getByRole('dialog', 'Revoke access for Fixture person?').getByRole('button', 'Revoke access').tap()
  await expect(privateCard.getByRole('button', 'Revoke access')).toHaveCount(0)
  await screen.getByRole('button', 'Bot assignment diagnostics').tap()
  await expect(screen.getByText(/Telegram bot 123456 · project.*assigned/)).toBeVisible()

  // The same wizard pairs a group member: a second receiver of the same bot; the cockpit retries the revision refresh itself.
  await screen.getByRole('combobox', 'Telegram receiver').selectOption({ label: 'Telegram group fixture (group)' })
  await screen.getByRole('checkbox', 'This bot is dedicated to this project: no other application receives its messages.').check()
  await expect(screen.getByRole('button', 'Create Telegram link')).toBeDisabled()
  await screen.getByRole('checkbox', 'I understand that all group members can read project messages, including people without permission to control tasks.').check()
  await screen.getByRole('button', 'Create Telegram link').tap()
  await expect(screen.getByText(/Comparison code:/)).toBeVisible()
  await expect(screen.getByRole('button', 'Activate task control')).toBeDisabled()
  await screen.getByRole('checkbox', 'I compared this code with the code the bot sent to this person privately.').check()
  await screen.getByRole('button', 'Activate task control').tap()
  await expect(screen.getByText(/Task control is active for Fixture person in this group/)).toBeVisible()
  const group = screen.getByRole('article', 'Telegram group fixture')
  await expect(group.getByRole('button', 'Disable replies')).toBeVisible()
  await group.getByRole('checkbox', 'Allow cancel for Telegram ID 456').check()
  await group.getByRole('checkbox', 'Allow continue for Telegram ID 456').check()
  await expect(group.getByRole('checkbox', 'Allow continue for Telegram ID 456')).toBeChecked()
  await group.getByRole('button', 'Disable replies').tap()
  await expect(group.getByRole('button', 'Enable replies')).toBeVisible()
  await group.getByRole('button', 'Revoke access').tap()
  await screen.getByRole('dialog', 'Revoke access for Fixture person?').getByRole('button', 'Revoke access').tap()
  await expect(group.getByRole('button', 'Revoke access')).toHaveCount(0)
})
