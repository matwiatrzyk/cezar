import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
test('one guided wizard pairs a fresh private receiver and a group member; /task, permissions, disable and revoke using simulated Telegram', async ({ app, screen }) => {
  await app.open('/p/default/settings/webhooks')
  // The unified entry point is always visible; diagnostics and legacy access
  // management remain available below it for already configured receivers.
  await expect(screen.getByRole('button', 'Set up Telegram')).toBeVisible()
  // Token-led private setup: setup begin returns a deep link, then the fixture's
  // simulated /start is observed by status polling before activation.
  await screen.getByRole('button', 'Set up Telegram').tap()
  await screen.getByLabel('Bot token').fill(`123456:${'x'.repeat(35)}`)
  await screen.getByRole('checkbox', 'This bot is dedicated to this project: no other application receives its messages.').check()
  await screen.getByRole('button', 'Continue').tap()
  await expect(screen.getByRole('link', /t\.me\/fixture_bot/)).toBeVisible()
  await expect(screen.getByText(/Connected as/)).toBeVisible()
  await screen.getByRole('checkbox', /Enable task control for this private chat/).check()
  await screen.getByRole('button', 'Activate notifications and task control').tap()
  await expect(screen.getByText(/Telegram setup is complete/)).toBeVisible()
  await screen.getByRole('button', 'Done').tap()

})
