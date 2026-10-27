import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

for (const [width, height] of [[390, 844], [1440, 1000]]) {
  test(`integrations gallery and provider panels at ${width}px`, async ({ app, screen, browser }) => {
    await browser.setViewport({ width, height })
    await browser.route('**/tracker/association', route => route.fulfill({ json: { association: {
      kind: 'jira', connectionId: 'gallery-test', source: { id: 'acme', webUrl: 'https://acme.atlassian.net' },
      externalId: '100', externalName: 'Platform',
    } } }))
    await browser.route('**/tracker/connection', route => route.fulfill({ json: { connection: {
      id: 'gallery-test', kind: 'jira', origin: 'https://acme.atlassian.net', email: 'user@example.com',
    }, demo: false } }))
    await browser.route('**/e2e', route => route.fulfill({ json: { configFile: 'e2e.config.ts', workflow: true, credentials: [], setup: null } }))
    await app.open('/settings/tracker')
    await expect(browser).toHaveURL(/\/settings\/integrations$/)
    await expect(screen.getByRole('button', 'Configure Jira')).toContainText('Connected')
    await expect(screen.getByRole('button', 'Configure TesterArmy e2e')).toContainText('Installed')
    await app.screenshot(`integrations-${width}`)
    for (const name of ['Slack', 'Discord', 'Webhooks']) {
      await screen.getByRole('button', `Configure ${name}`).tap()
      await expect(screen.getByRole('button', 'Add receiver')).toBeVisible()
      await screen.getByRole('button', 'All integrations').tap()
      await expect(screen.getByRole('button', `Configure ${name}`)).toBeVisible()
    }

    await screen.getByRole('button', 'Configure Jira').tap()
    await expect(screen.getByRole('dialog', 'Jira')).toBeVisible()
    await screen.getByRole('button', 'Replace Jira credentials').tap()
    await expect(screen.getByLabel('Jira site URL')).toBeVisible()
    await expect(screen.getByRole('button', 'Configure Linear credentials')).toHaveCount(0)
    await expect.poll(() => browser.evaluate(() => {
      const el = document.querySelector('[role="dialog"]')!
      const box = el.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth
    })).toBe(true)
    await app.screenshot(`jira-panel-${width}`)
    await browser.keyboard.press('Escape')
    await expect(screen.getByRole('dialog')).toHaveCount(0)
    await expect(screen.getByRole('button', 'Configure Jira')).toBeFocused()
    await screen.getByRole('button', 'Configure Linear').tap()
    await expect(screen.getByText('replaces the issue source', { exact: false })).toBeVisible()
    await expect(screen.getByRole('button', 'Disconnect')).toHaveCount(0)
    await browser.keyboard.press('Escape')
    await screen.getByRole('button', 'Configure TesterArmy e2e').tap()
    await expect(screen.getByRole('dialog', 'TesterArmy e2e')).toBeVisible()
    await expect(screen.getByRole('button', 'Set up again')).toBeVisible()
    await app.screenshot(`testerarmy-panel-${width}`)
    await browser.keyboard.press('Escape')
  })
}

for (const [width, height] of [[390, 844], [1440, 1000]]) {
  test(`notification receiver forms and legacy links at ${width}px`, async ({ app, screen, browser }) => {
    await browser.setViewport({ width, height })
    await browser.route('**/api/v1/p/*/webhooks', route => route.fulfill({ json: {
      receivers: [], history: [], historyCount: 0, changeSequence: 0, webhookHealth: { status: 'ready' },
    } }))
    await app.open('/settings/webhooks')
    await expect(browser).toHaveURL(/\/settings\/integrations\?integration=webhooks$/)
    await expect(screen.getByRole('button', 'Add receiver')).toBeVisible()
    await screen.getByRole('button', 'All integrations').tap()
    for (const [name, format] of [['Slack', 'slack.v1'], ['Discord', 'discord.v1'], ['Webhooks', 'cezar.json.v1']]) {
      await screen.getByRole('button', `Configure ${name}`).tap()
      await screen.getByRole('button', 'Add receiver').tap()
      await expect.poll(() => browser.evaluate(() => (document.querySelector('select') as HTMLSelectElement)?.value)).toBe(format)
      await expect.poll(() => browser.evaluate(() => {
        const el = document.querySelector('[role="dialog"]')!
        const box = el.getBoundingClientRect()
        return box.left >= 0 && box.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth
      })).toBe(true)
      await app.screenshot(`${name.toLowerCase()}-receiver-${width}`)
      await browser.keyboard.press('Escape')
      await expect(screen.getByRole('dialog')).toHaveCount(0)
      await expect(screen.getByRole('button', 'Add receiver')).toBeFocused()
      await screen.getByRole('button', 'All integrations').tap()
      await expect.poll(() => browser.evaluate(() => document.body.style.pointerEvents)).not.toBe('none')
    }
  })
}
