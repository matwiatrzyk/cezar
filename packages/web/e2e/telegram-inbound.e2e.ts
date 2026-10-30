import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
test('private and group pairing, control permissions, disable and revoke using simulated Telegram', async ({ app, screen }) => {
  await app.open('/p/default/settings/webhooks')
  await expect(screen.getByRole('button', 'Two-way Telegram')).toBeVisible()
  await screen.getByRole('button', 'Two-way Telegram').tap()
  // Notifications only checks the saved token and pairs nobody.
  await screen.getByRole('button', 'Start guided setup').tap()
  await screen.getByRole('combobox', 'Telegram receiver').selectOption({ label: 'Telegram inbound fixture' })
  await screen.getByRole('button', 'Check bot token').tap()
  await expect(screen.getByText(/works \(@fixture_bot\)\. Notifications keep arriving in Telegram\. Nobody was paired/)).toBeVisible()
  await screen.getByRole('button', 'Done').tap()
  await expect(screen.getByRole('article', 'Telegram inbound fixture').getByRole('button', 'Pair person')).toBeDisabled()
  await screen.getByRole('checkbox', 'This bot is dedicated to this project and is not used by another application to receive messages.').check()
  await screen.getByRole('article', 'Telegram inbound fixture').getByRole('button', 'Pair person').tap()
  await screen.getByRole('dialog', 'What should Telegram do for this receiver?').getByRole('radio', /Task control/).check()
  await screen.getByRole('button', 'Start pairing for task control').tap()
  await expect(screen.getByRole('link', 'Open Telegram to pair')).toBeVisible()
  await expect(screen.getByText('Fixture person · Telegram ID 456')).toBeVisible()
  await screen.getByRole('button', 'Approve for task control').tap()
  await expect(screen.getByRole('button', 'Disable replies')).toBeVisible()
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
  const telegramRun = await fetch(`${base}/api/v1/runs/${telegramRunId}`).then(response => response.json()) as { telegramSource?: { chatId?: string; userId?: string } }
  expect(telegramRun.telegramSource).toMatchObject({ chatId: '456', userId: '456' })
  await screen.getByRole('button', 'Disable replies').tap()
  await expect(screen.getByRole('button', 'Enable replies')).toBeVisible()
  await screen.getByRole('button', 'Revoke access').tap()
  await screen.getByRole('dialog', 'Revoke access for Fixture person?').getByRole('button', 'Revoke access').tap()
  await expect(screen.getByRole('button', 'Revoke access')).toHaveCount(0)
  await screen.getByRole('button', 'Bot assignment diagnostics').tap()
  await expect(screen.getByText(/Telegram bot 123456 · project.*assigned/)).toBeVisible()

  // Add a second receiver of the same bot; discovery refreshes its revision first.
  await app.open('/p/default/settings/webhooks')
  await screen.getByRole('button', 'Two-way Telegram').tap()
  const group = screen.getByRole('article', 'Telegram group fixture')
  await screen.getByRole('checkbox', 'This bot is dedicated to this project and is not used by another application to receive messages.').check()
  await expect(group.getByRole('button', 'Pair person')).toBeDisabled()
  await screen.getByRole('checkbox', 'I understand that all group members can read project messages, including people without permission to control tasks.').check()
  // The cockpit retries the server's revision refresh itself, so one click starts pairing.
  await group.getByRole('button', 'Pair person').tap()
  await screen.getByRole('dialog', 'What should Telegram do for this receiver?').getByRole('radio', /Task control/).check()
  await screen.getByRole('button', 'Start pairing for task control').tap()
  await expect(screen.getByText(/Comparison code:/)).toBeVisible()
  await expect(screen.getByRole('button', 'Approve for task control')).toBeDisabled()
  await screen.getByRole('checkbox', 'I compared this code with the code sent privately by the bot.').check()
  await screen.getByRole('button', 'Approve for task control').tap()
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
