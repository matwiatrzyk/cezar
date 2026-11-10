import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import type { ExtensionInventoryItem, ExtensionUninstallImpact } from '@open-mercato/cezar-api-client'

const item: ExtensionInventoryItem = {
  record: { manifest: { id: 'example', name: 'Mattermost', version: '1.0.0', apiVersion: '0.1', entry: 'index.js', permissions: [], actions: [], panels: [],
    contributes: { forms: [], panels: [], commands: [], chatProviders: [{ id: 'chat', label: 'Mattermost', commandPrefix: '!', groupPrefix: 'group:', credentials: [], limits: { maxText: 4000, buttonsPerMessage: 5, perChatPerSecond: 1, perBotPerSecond: 10 }, discoveryUrl: 'https://example.com' }] } },
    source: '/untrusted/bundled-chat/example', installedAt: '', enabled: false, status: 'disabled' },
  provenance: { kind: 'folder', source: '/untrusted/bundled-chat/example' }, availability: 'missing', selectedVersion: '1.0.0', providers: [{ id: 'example/chat', label: 'Mattermost' }],
}
const impact = (changed: boolean): ExtensionUninstallImpact => ({
  extensionId: 'example', scope: 'all-projects', revision: (changed ? 'b' : 'a').repeat(64), retainsConnectionData: true,
  projects: [{ projectId: changed ? 'gamma' : 'beta', name: changed ? 'Gamma app' : 'Beta app', enabled: true, providers: ['example/chat'] }],
})

test('cold missing recovery retains focus, project navigation and mobile wrapping', async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 320, height: 812 })
  const requests: string[] = []
  await browser.route(/\/api\/v1\//, async route => {
    const path = new URL(route.request.url).pathname
    requests.push(path)
    if (path.endsWith('/inventory')) return route.fulfill({ json: { extensions: [item] } })
    if (path.endsWith('/access')) return route.fulfill({ json: { extensions: [] } })
    if (/\/(telegram|slack|discord)$/.test(path)) return route.fulfill({ json: { available: false, notifications: { available: false, reason: 'webhooks_off' }, taskControl: { available: false }, receivers: [], bots: [], grants: [] } })
    if (path.endsWith('/tracker/association')) return route.fulfill({ json: { association: null } })
    if (path.endsWith('/tracker/connection')) return route.fulfill({ json: { connection: null } })
    if (path.endsWith('/e2e')) return route.fulfill({ json: { configFile: null, workflow: false, credentials: [], setup: null } })
    return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
  })
  await app.open('/e2e/inventory-harness.html?recovery=1')
  await expect(screen.getByRole('region', 'Mattermost')).toBeVisible()
  await expect(screen.getByText('Missing', { exact: true })).toBeVisible()
  expect(await browser.evaluate(() => document.activeElement?.textContent ?? null)).toBe('Mattermost')
  await expect(screen.getByRole('button', 'Connect Mattermost')).not.toBeVisible()
  await screen.getByRole('link', 'Manage extension').click()
  await expect(screen.getByRole('listitem', 'Mattermost')).toBeVisible()
  await expect(screen.getByText('Local extension', { exact: true })).toBeVisible()
  await expect(screen.getByRole('button', 'Enable', { exact: true })).not.toBeVisible()
  expect(await browser.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320)
  expect(requests.some(path => path.includes('/extensions/example/chat/'))).toBe(false)
  await expect(screen.getByRole('combobox', 'Project access')).toHaveValue('default')
  expect(requests.some(path => path.includes('/p/alpha/extensions/inventory'))).toBe(true)
})

test('global uninstall refreshes stale preview and needs a second explicit confirmation', async ({ app, browser, screen }) => {
  let changed = false
  let removed = false
  const deletes: URL[] = []
  await browser.route(/\/api\/v1\//, async route => {
    const url = new URL(route.request.url)
    if (route.request.method === 'DELETE') {
      deletes.push(url)
      if (!changed) { changed = true; return route.fulfill({ status: 409, json: { error: 'Impact changed' } }) }
      removed = true
      return route.fulfill({ json: { ok: true } })
    }
    if (url.pathname.endsWith('/uninstall-impact')) return route.fulfill({ json: impact(changed) })
    if (url.pathname.endsWith('/inventory')) return route.fulfill({ json: { extensions: removed ? [] : [{ ...item, availability: 'disabled' }] } })
    if (url.pathname.endsWith('/access')) return route.fulfill({ json: { extensions: removed ? [] : [item.record] } })
    return route.fulfill({ status: 404, json: { error: 'Fixture: unavailable' } })
  })
  await app.open('/e2e/inventory-harness.html')
  await screen.getByRole('button', 'Uninstall', { exact: true }).click()
  await expect(screen.getByText(/Beta app.*Enabled/)).toBeVisible()
  await expect(screen.getByText(/removes the extension from all projects/)).toBeVisible()
  await screen.getByRole('button', 'Uninstall and keep data').click()
  await expect(screen.getByText(/Gamma app.*Enabled/)).toBeVisible()
  await expect(screen.getByText(/confirm again/)).toBeVisible()
  expect(deletes.length).toBe(1)
  expect(deletes[0]!.searchParams.get('impactRevision')).toBe('a'.repeat(64))
  await screen.getByRole('button', 'Uninstall and keep data').click()
  await expect(screen.getByText('No extensions installed', { exact: true })).toBeVisible()
  expect(deletes.length).toBe(2)
  expect(deletes[1]!.searchParams.get('impactRevision')).toBe('b'.repeat(64))
  expect(deletes[1]!.searchParams.get('removeData')).toBe('false')
})
