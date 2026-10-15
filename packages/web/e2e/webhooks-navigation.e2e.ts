import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AgentBrowser, bootProjectId, cezarCli, fixtureServeEnv } from './agent-browser'
const artifacts = resolve(import.meta.dirname, '../../../.ai/qa/artifacts_e2e')
let browser: AgentBrowser, server: ChildProcess, root: string, url: string, project: string
async function availablePort(): Promise<number> {
  return new Promise((done, reject) => { const s = createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const a = s.address(); const p = typeof a === 'object' && a ? a.port : 0; s.close(() => done(p)) }) })
}
async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
  return fetch(`${url}/api/v1${path}`, { method, headers: { 'content-type': 'application/json', connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'cezar-e2e-webhooks-')); execFileSync('git', ['init', '-q'], { cwd: root })
  const port = await availablePort(); url = `http://127.0.0.1:${port}`
  server = spawn(process.execPath, [cezarCli, 'serve', '--repo', root, '--port', String(port), '--no-open'], { env: fixtureServeEnv(root, { CEZ_WEBHOOKS: '1' }), stdio: 'ignore' })
  for (let i = 0; i < 80; i++) { try { if ((await api('/health')).ok) break } catch { /* boot */ } await new Promise(r => setTimeout(r, 250)) }
  project = await bootProjectId(url); browser = AgentBrowser.open(`e2e-webhooks-navigation-${process.pid}`); browser.setViewport(1440, 1000)
}, 90000)
afterAll(async () => {
  browser?.close()
  if (server && server.exitCode === null) { server.kill(); await new Promise<void>(done => { if (server.exitCode !== null) return done(); server.once('exit', () => done()); setTimeout(done, 5000).unref() }) }
  if (root) rmSync(root, { recursive: true, force: true })
})

describe('webhook history navigation and mobile boundaries', () => {
  beforeAll(async () => {
    const response = await api('/webhooks', { name: 'W'.repeat(100), url: 'https://receiver.invalid/ui-regression' })
    expect(response.status).toBe(201)
    // Do not serialize the returned signing secret.
  })
  const openList = () => {
    browser.goto(`${url}/p/${project}/settings/webhooks`)
    browser.waitForFunction("document.querySelector('article h3') !== null")
  }
  const clickReceiverAction = (label: string) => {
    browser.evaluate(`(() => { const button = [...document.querySelectorAll('article button')].find(b => b.textContent.trim() === ${JSON.stringify(label)}); if (!button) throw Error('Missing receiver action'); button.id = 'webhook-action-target'; button.scrollIntoView({ block: 'center', behavior: 'instant' }) })()`)
    browser.click('#webhook-action-target')
    browser.evaluate("document.getElementById('webhook-action-target')?.removeAttribute('id')")
  }
  const openHistory = () => {
    clickReceiverAction('History')
    browser.waitForFunction("document.querySelector('[role=dialog]') !== null")
  }
  const waitClosed = () => browser.waitForFunction("document.querySelector('[role=dialog]') === null")
  it('returns keyboard focus to History after Escape', () => {
    openList(); openHistory(); browser.press('Escape'); waitClosed()
    expect(browser.evaluate('document.activeElement?.textContent.trim()')).toBe('History')
  })
  it('returns keyboard focus to the deleted receiver after native Escape', async () => {
    const response = await api('/webhooks', { name: 'Retired receiver', url: 'https://receiver.invalid/retired' })
    expect(response.status).toBe(201)
    const { receiver } = await response.json()
    expect((await api('/webhooks/' + receiver.id, { expectedRevision: receiver.revision }, 'DELETE')).ok).toBe(true)
    openList()
    browser.evaluate("document.querySelectorAll('button').forEach(b => { if (b.textContent === 'Deleted receivers (1)') b.id = 'show-deleted' })")
    browser.click('#show-deleted')
    browser.waitForFunction("[...document.querySelectorAll('button')].some(b => b.textContent.includes('Retired receiver — deleted'))")
    browser.evaluate("[...document.querySelectorAll('button')].find(b => b.textContent.includes('Retired receiver — deleted')).id = 'deleted-history-trigger'")
    browser.click('#deleted-history-trigger')
    browser.waitForFunction("document.querySelector('[role=dialog] h2')?.textContent === 'Retired receiver history'")
    browser.press('Escape'); waitClosed()
    browser.waitForFunction("[...document.getAnimations()].filter(a => a.effect?.getTiming().iterations !== Infinity).every(a => a.playState !== 'running')")
    const focus = browser.evaluate("({ tag: document.activeElement?.tagName, id: document.activeElement?.id })")
    console.log('Deleted receiver focus after native Escape', focus)
    expect(focus).toEqual({ tag: 'BUTTON', id: 'deleted-history-trigger' })
  })
  it('discards confirmation when browser Back reopens history', () => {
    openList(); openHistory(); browser.press('Escape'); waitClosed()
    clickReceiverAction('Activate')
    browser.waitForFunction("document.querySelector('[role=dialog] h2')?.textContent === 'Activate receiver?'")
    browser.evaluate('history.back()')
    browser.waitForFunction("document.querySelector('[role=tab]') !== null")
    browser.press('Escape')
    browser.waitForFunction("[...document.getAnimations()].filter(a => a.effect?.getTiming().iterations !== Infinity).every(a => a.playState !== 'running')")
    expect(browser.count('[role=dialog]')).toBe(0)
  })
  it('keeps a valid unbroken 100-character name inside the mobile list and history', () => {
    openList(); browser.setViewport(390, 844)
    const heading = browser.evaluate("(() => { const h = document.querySelector('article h3'); return { width: h.clientWidth, scroll: h.scrollWidth } })()") as { width: number; scroll: number }
    openHistory()
    browser.waitForFunction("[...document.getAnimations()].filter(a => a.effect?.getTiming().iterations !== Infinity).every(a => a.playState !== 'running')")
    const dialog = browser.evaluate("(() => { const d = document.querySelector('[role=dialog]'); return { width: d.clientWidth, scroll: d.scrollWidth } })()") as { width: number; scroll: number }
    console.log('Mobile name bounds', { heading, dialog })
    browser.screenshot(`${artifacts}/webhooks-navigation-mobile.png`)
    expect(dialog.scroll).toBeLessThanOrEqual(dialog.width)
    expect(heading.scroll).toBeLessThanOrEqual(heading.width)
    expect(browser.evaluate("(() => { const b = [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent === 'Find task').getBoundingClientRect(); const d = document.querySelector('[role=dialog]').getBoundingClientRect(); return b.left >= d.left && b.right <= d.right })()")).toBe(true)
  })
})
