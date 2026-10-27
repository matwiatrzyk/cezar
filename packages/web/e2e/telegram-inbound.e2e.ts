import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
test('private pairing, explicit approval, disable and revoke using simulated Telegram', async ({ app, screen }) => {
  await app.open('/p/default/settings/webhooks')
  await screen.getByRole('button', 'Two-way Telegram').tap()
  await expect(screen.getByRole('button', 'Pair person')).toBeDisabled()
  await screen.getByRole('checkbox', 'This bot is dedicated to this project and is not used by another application to receive messages.').check()
  await screen.getByRole('button', 'Pair person').tap()
  await expect(screen.getByRole('link', 'Open Telegram to pair')).toBeVisible()
  await expect(screen.getByText('Fixture person · Telegram ID 456')).toBeVisible()
  await screen.getByRole('button', 'Approve this person').tap()
  await expect(screen.getByRole('button', 'Disable replies')).toBeVisible()
  await screen.getByRole('button', 'Disable replies').tap()
  await expect(screen.getByRole('button', 'Enable replies')).toBeVisible()
  await screen.getByRole('button', 'Revoke access').tap()
  await expect(screen.getByRole('button', 'Revoke access')).toHaveCount(0)
  await screen.getByRole('button', 'Bot assignment diagnostics').tap()
  await expect(screen.getByText(/Bot 123456 · project.*assigned/)).toBeVisible()
})
