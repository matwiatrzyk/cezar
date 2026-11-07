import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatTransportError, type ChatTransport } from '../chat/provider.ts'
import type { ChatConnectionOptions, ReceiveJournal } from '../chat/connection.ts'
import { BundledChatOwner } from './bundled-host.ts'

// Becomes ready, answers identify, and dies as soon as it is asked to connect.
const WORKER = `
import { createInterface } from 'node:readline'
let generation = ''
const out = frame => process.stdout.write(JSON.stringify({ providerId: 'discord', generation, ...frame }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  if (frame.type === 'start') { generation = frame.generation; return out({ type: 'ready' }) }
  if (frame.type === 'connect') process.exit(3)
  if (frame.type === 'stop') process.exit(0)
  if (frame.type === 'call') out({ type: 'response', requestId: frame.requestId, ok: true, result: { id: 'worker', username: 'worker' } })
})
`
// Scripted per spawn through config.mode; records its pid (and a connect) under config.pids.
const SCRIPTED = `
import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
let generation = '', config = {}
const out = frame => process.stdout.write(JSON.stringify({ providerId: 'discord', generation, ...frame }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  if (frame.type === 'start') {
    generation = frame.generation; config = frame.config
    writeFileSync(join(config.pids, String(process.pid)), '')
    if (config.mode === 'exit-before-ready') process.exit(1)
    return out({ type: 'ready' })
  }
  if (frame.type === 'connect') {
    if (config.mode === 'crash-on-connect') process.exit(3)
    writeFileSync(join(config.pids, process.pid + '.connected'), '')
  }
  if (frame.type === 'stop') process.exit(0)
})
`
const roots: string[] = [], owners: BundledChatOwner[] = []
afterEach(async () => { await Promise.all(owners.splice(0).map(owner => owner.stop())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const manifest = { id: 'discord' as const, version: '1.0.0', entry: 'index.mjs', integrity: 'sha512-x', format: 'discord.v1' as const }
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cez-bundled-host-')); roots.push(root)
  const dir = join(root, 'dist', 'bundled-chat', 'discord'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), WORKER)
  const starts: string[] = [], health: string[] = [], logs: string[] = []
  const compatibility = {
    identify: async () => ({ id: 'compat', username: 'compat' }),
    guarded() { return compatibility },
    connect: () => ({ start: () => { starts.push('start') }, stop: async () => {}, health: () => ({ state: 'polling' as const }) }),
  } as unknown as ChatTransport
  const options = { accept: async () => {}, process: async () => {}, needed: () => true, assertCredentials: async () => {}, onHealth: (value: { state: string }) => { health.push(value.state) } } as ChatConnectionOptions
  return { root, compatibility, options, starts, health, logs }
}
const alive = (pid: number | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }

function scripted(modes: string[]) {
  const s = setup()
  writeFileSync(join(s.root, 'dist', 'bundled-chat', 'discord', 'index.mjs'), SCRIPTED)
  const pids = join(s.root, 'pids'); mkdirSync(pids)
  let spawns = 0
  const config = async () => ({ pids, mode: modes[Math.min(spawns++, modes.length - 1)]! })
  const live = () => readdirSync(pids).filter(name => /^\d+$/.test(name)).map(Number).filter(pid => alive(pid))
  const connected = () => readdirSync(pids).filter(name => name.endsWith('.connected')).map(name => Number.parseInt(name, 10)).filter(pid => alive(pid))
  return { ...s, config, live, connected, spawns: () => spawns }
}

describe('bundled chat owner', () => {
  it('a first worker that exits before ready fails activation and never respawns (H1)', async () => {
    const s = scripted(['exit-before-ready', 'ok'])
    await expect(BundledChatOwner.activate({ manifest, packageRoot: s.root, config: s.config, compatibility: s.compatibility, log: () => {}, restartDelayMs: () => 10 })).rejects.toThrow()
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(s.spawns()).toBe(1)
    expect(s.live()).toEqual([])
  })

  it('a respawn that exits before ready counts once: one connected worker, none after stop (H1)', async () => {
    const s = scripted(['crash-on-connect', 'exit-before-ready', 'ok'])
    const owner = await BundledChatOwner.activate({ manifest, packageRoot: s.root, config: s.config, compatibility: s.compatibility, log: () => {}, restartDelayMs: () => 10 })
    owners.push(owner)
    owner.transport(() => true).connect({} as ReceiveJournal, s.options).start()
    await expect.poll(() => s.connected().length, { timeout: 10_000 }).toBe(1)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(s.spawns()).toBe(3)
    expect(s.live()).toEqual(s.connected())
    expect(owner.pid).toBe(s.connected()[0])
    await owner.stop()
    await expect.poll(() => s.live()).toEqual([])
  })

  it('restarts a crash loop a bounded number of times, then falls back to compatibility (#F3)', async () => {
    const s = setup()
    const owner = await BundledChatOwner.activate({ manifest, packageRoot: s.root, config: async () => ({}), compatibility: s.compatibility, log: line => { s.logs.push(line) }, maxRestarts: 2, restartDelayMs: () => 20 })
    owners.push(owner)
    await expect(owner.transport(() => true).identify()).resolves.toEqual({ id: 'worker', username: 'worker' })
    owner.transport(() => true).connect({} as ReceiveJournal, s.options).start()
    await expect.poll(() => owner.mode, { timeout: 10_000 }).toBe('compatibility')
    expect(s.logs.filter(line => /restarting/.test(line))).toHaveLength(2)
    expect(s.logs.some(line => /restarts exhausted/.test(line))).toBe(true)
    expect(s.health).toContain('backoff')
    expect(s.starts).toEqual(['start'])
    expect(owner.pid).toBeUndefined()
    // After fall-back every operation goes to the in-process adapter.
    await expect(owner.transport(() => true).identify()).resolves.toEqual({ id: 'compat', username: 'compat' })
  })

  it('answers a call made while restarting with a retryable failure, never a hang', async () => {
    const s = setup()
    const owner = await BundledChatOwner.activate({ manifest, packageRoot: s.root, config: async () => ({}), compatibility: s.compatibility, log: () => {}, restartDelayMs: () => 60_000 })
    owners.push(owner)
    owner.transport(() => true).connect({} as ReceiveJournal, s.options).start()
    await expect.poll(() => s.health.includes('backoff')).toBe(true)
    const error = await owner.transport(() => true).identify().catch(value => value)
    expect(error).toBeInstanceOf(ChatTransportError)
    expect((error as ChatTransportError).failure.kind).toBe('transient')
  })

  it('stop during backoff leaves no worker and never respawns', async () => {
    const s = setup()
    const owner = await BundledChatOwner.activate({ manifest, packageRoot: s.root, config: async () => ({}), compatibility: s.compatibility, log: () => {}, restartDelayMs: () => 100 })
    const first = owner.pid
    owner.transport(() => true).connect({} as ReceiveJournal, s.options).start()
    await expect.poll(() => s.health.includes('backoff')).toBe(true)
    await owner.stop()
    await new Promise(r => setTimeout(r, 250))
    expect(owner.pid).toBeUndefined()
    expect(alive(first)).toBe(false)
    expect(s.starts).toEqual([])
  })

  it('validates worker answers instead of passing them through (L1)', async () => {
    const s = setup()
    const owner = await BundledChatOwner.activate({ manifest, packageRoot: s.root, config: async () => ({}), compatibility: s.compatibility, log: () => {} })
    owners.push(owner)
    // This worker answers every call with an identity, which is not an inspect result.
    await expect(owner.transport(() => true).inspect('chat-1')).rejects.toThrow()
    await expect(owner.transport(() => true).identify()).resolves.toMatchObject({ id: 'worker' })
  })

  it('a fenced transport refuses before anything crosses the boundary (#F8)', async () => {
    const s = setup()
    const owner = await BundledChatOwner.activate({ manifest, packageRoot: s.root, config: async () => ({}), compatibility: s.compatibility, log: () => {} })
    owners.push(owner)
    await expect(owner.transport(() => false).identify()).rejects.toMatchObject({ failure: { kind: 'blocked' } })
    await expect(owner.transport(() => true).guarded(() => false).identify()).rejects.toMatchObject({ failure: { kind: 'blocked' } })
  })
})
