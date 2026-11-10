import { test } from '@e2e-dev/web'
import { expect } from 'e2e'

for (const width of [320, 375]) {
  test(`category geometry and keyboard at ${width}`, async ({ app, screen, browser }) => {
    await browser.setViewport({ width, height: 812 })
    await app.open('/p/default/settings/integrations')
    await expect(screen.getByRole('button', 'Configure Jira')).toBeVisible()
    const geometry = await browser.evaluate(() => {
      const group = document.querySelector('[data-slot="integration-category-filter"]')!
      return {
        viewport: innerWidth,
        page: document.documentElement.scrollWidth,
        buttons: Array.from(group.querySelectorAll('button')).map(button => {
          const { left, right } = button.getBoundingClientRect()
          return { left, right }
        }),
      }
    })
    console.log('GEOMETRY', width, JSON.stringify(geometry))
    expect(geometry.page).toBeLessThanOrEqual(width)
    expect(geometry.buttons).toHaveLength(5)
    for (const button of geometry.buttons) {
      expect(button.left).toBeGreaterThanOrEqual(0)
      expect(button.right).toBeLessThanOrEqual(width)
    }

    await screen.getByRole('searchbox', 'Search integrations').click()
    for (const category of ['all', 'Chat', 'Issue tracking', 'Testing', 'Webhooks']) {
      await browser.keyboard.press('Tab')
      expect(await browser.evaluate(() => document.activeElement?.getAttribute('data-value') ?? null)).toBe(category)
      await browser.keyboard.press('Enter')
      expect(await browser.evaluate(() => document.activeElement?.getAttribute('aria-pressed') ?? null)).toBe('true')
    }
  })
}
