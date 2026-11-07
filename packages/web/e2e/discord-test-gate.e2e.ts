import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
test('discord failed bot test cannot activate notifications or grant access', async ({ app, screen, browser }) => {
 if (!app.baseUrl) throw new Error('Missing fixture URL')
 const base = app.baseUrl.replace(/\/$/, '')
 const control = new URL(base); control.port = String(Number(control.port) + 1)
 const fixture = async (path = '/', data?: unknown) => {
  const response = await fetch(new URL(path, control), data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) })
  if (!response.ok) throw new Error(await response.text())
  return response.json()
 }
 const receivers = async () => (await fetch(base + '/api/v1/webhooks').then(r => r.json())).receivers
 const initial = await fixture()
 await app.open('/p/default/settings/integrations?integration=discord')
 await screen.getByRole('button', 'Add task control to Existing webhook').tap()
 await screen.getByLabel('Bot token').fill('a'.repeat(24) + '.' + 'b'.repeat(6) + '.' + 'c'.repeat(27))
 await expect(screen.getByRole('button', 'Continue')).toBeDisabled()
 expect((await fixture()).calls).toBe(0)
 await screen.getByRole('checkbox', 'This bot is dedicated to this Cezar project.').check()
 await screen.getByRole('button', 'Continue').tap()
 await expect(screen.getByLabel('Command for private chat')).toBeVisible()
 await expect(screen.getByRole('button', 'Activate notifications')).toBeDisabled()
 const command = await screen.getByLabel('Command for private chat').inputValue()
 await fixture('/message', { text: command })
 await expect(screen.getByRole('checkbox', 'Enable task control for this private chat')).toBeVisible()
 await screen.getByRole('checkbox', 'Enable task control for this private chat').check()
 await screen.getByRole('checkbox', 'Start tasks').check()
 await fixture('/fail-send', { value: true })
 await screen.getByRole('button', 'Activate notifications and task control').tap()
 await expect(screen.getByRole('button', 'Activate notifications and task control')).toBeEnabled()
 expect((await receivers()).find((r: any) => r.id === initial.seedId).state).not.toBe('active')
 expect((await fixture()).inbound.grants).toHaveLength(0)
})
