import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ChatTransportError } from '../chat/provider.ts'
import { bundledWorkerEnv, startBundledProvider, type BundledProviderHandle } from './bundled-runtime.ts'
import { bundledHostFrameSchema, bundledWorkerFrameSchema } from './protocol.ts'

// A scripted stand-in worker: config.mode picks a misbehaviour the host must survive.
const WORKER = `
import { createInterface } from 'node:readline'
let generation = '', mode = ''
const out = frame => process.stdout.write(JSON.stringify({ providerId: 'slack', generation, ...frame }) + '\\n')
createInterface({ input: process.stdin }).on('line', line => {
  const frame = JSON.parse(line)
  if (frame.type === 'start') {
    generation = frame.generation; mode = frame.config.mode
    if (mode === 'ignore-term') process.on('SIGTERM', () => {})
    if (mode === 'no-ready') return
    if (mode === 'stderr') process.stderr.write(('x'.repeat(1023) + '\\n').repeat(256))
    return out({ type: 'ready' })
  }
  if (frame.type === 'cancel') process.stderr.write('cancelled ' + frame.requestId + '\\n')
  if (frame.type === 'stop' && mode !== 'ignore-term') process.exit(0)
  if (frame.type !== 'call') return
  if (mode === 'hang' || mode === 'ignore-term') return
  if (mode === 'env') return out({ type: 'response', requestId: frame.requestId, ok: true, result: process.env })
  if (mode === 'fail') return out({ type: 'response', requestId: frame.requestId, ok: false, error: { message: 'x', failure: { kind: 'auth' } } })
  if (mode === 'stale') out({ type: 'response', requestId: frame.requestId, ok: true, result: 'stale', generation: 'other' })
  out({ type: 'response', requestId: frame.requestId, ok: true, result: frame.input })
})
`
const roots: string[] = [], handles: BundledProviderHandle[] = []
afterEach(async () => {
  await Promise.all(handles.splice(0).map(handle => { handle.process.kill('SIGKILL'); return handle.stop() }))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const manifest = { id: 'slack' as const, version: '1.0.0', entry: 'index.mjs', integrity: 'sha512-x', format: 'slack.v1' as const }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-bundled-runtime-')); roots.push(root)
  const dir = join(root, 'dist', 'bundled-chat', 'slack'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.mjs'), WORKER)
  return root
}
async function start(mode: string, extra: Partial<Parameters<typeof startBundledProvider>[1]> = {}) {
  const logs: string[] = []
  const handle = await startBundledProvider(manifest, { packageRoot: fixture(), config: { mode }, onHostRequest: async () => undefined, log: line => { logs.push(line) }, ...extra })
  handles.push(handle)
  return { handle, logs }
}
const exited = (handle: BundledProviderHandle) => new Promise<void>(done => { if (handle.process.exitCode !== null || handle.process.signalCode !== null) done(); else handle.process.once('exit', () => done()) })

describe('bundled worker runtime (host side)', () => {
  it('starts with the generation first, so a call before connect is answered (#F2)', async () => {
    const { handle } = await start('echo')
    await expect(handle.call('identify', { probe: 1 })).resolves.toEqual({ probe: 1 })
  })

  it('fences responses from another generation', async () => {
    const { handle } = await start('stale')
    await expect(handle.call('identify', { real: true })).resolves.toEqual({ real: true })
  })

  it('keeps the failure kind across the boundary', async () => {
    const { handle } = await start('fail')
    const error = await handle.call('identify').catch(value => value)
    expect(error).toBeInstanceOf(ChatTransportError)
    expect((error as ChatTransportError).failure.kind).toBe('auth')
  })

  it('bounds a call with a deadline and cancels it in the worker (#F3)', async () => {
    const { handle, logs } = await start('hang', { callTimeoutMs: 200 })
    const error = await handle.call('identify').catch(value => value)
    expect((error as ChatTransportError).failure.kind).toBe('transient')
    await expect.poll(() => logs.some(line => line.includes('cancelled call-1'))).toBe(true)
  })

  it('rejects pending calls when the worker dies, and reports the crash (#F3)', async () => {
    const crashes: Error[] = []
    const { handle } = await start('hang', { onExit: error => { crashes.push(error) } })
    const pending = handle.call('identify')
    handle.process.kill('SIGKILL')
    await expect(pending).rejects.toBeInstanceOf(ChatTransportError)
    await expect.poll(() => crashes.length).toBe(1)
    expect(handle.alive).toBe(false)
  })

  it('cancels an in-flight call once the host fence closes (#F8)', async () => {
    const { handle, logs } = await start('hang')
    let valid = true
    const pending = handle.call('send', {}, { valid: () => valid })
    valid = false
    const error = await pending.catch(value => value)
    expect((error as ChatTransportError).failure.kind).toBe('blocked')
    await expect.poll(() => logs.some(line => line.includes('cancelled call-1'))).toBe(true)
  })

  it('cancels on abort', async () => {
    const { handle } = await start('hang')
    const controller = new AbortController()
    const pending = handle.call('identify', {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(ChatTransportError)
  })

  it('drains a flood of stderr instead of blocking the worker (#F10)', async () => {
    const { handle, logs } = await start('stderr')
    await expect(handle.call('identify', { after: 'stderr' })).resolves.toEqual({ after: 'stderr' })
    expect(logs.length).toBeLessThanOrEqual(50)
  })

  it('escalates to SIGKILL when the worker ignores stop and SIGTERM (#F10)', async () => {
    const { handle } = await start('ignore-term', { stopTimeoutMs: 100 })
    const started = Date.now()
    await handle.stop()
    await exited(handle)
    expect(handle.process.signalCode).toBe('SIGKILL')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('fails activation and leaves no process when the worker never becomes ready', async () => {
    const before = process.listenerCount('exit')
    await expect(startBundledProvider(manifest, { packageRoot: fixture(), config: { mode: 'no-ready' }, readyTimeoutMs: 200, stopTimeoutMs: 100, onHostRequest: async () => undefined, log: () => {} })).rejects.toThrow(/ready/)
    expect(process.listenerCount('exit')).toBe(before)
  })

  it('passes proxy and CA settings, never PATH, HOME or NODE_OPTIONS (#F10)', async () => {
    const env = { PATH: '/bin', HOME: '/home/x', NODE_OPTIONS: '--require evil', HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem', SLACK_TOKEN: 'secret' }
    expect(bundledWorkerEnv(env)).toEqual({ NODE_ENV: 'production', HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: 'localhost', NODE_EXTRA_CA_CERTS: '/ca.pem' })
    const { handle } = await start('env', { env })
    const seen = await handle.call('identify') as Record<string, string>
    expect(seen.HTTPS_PROXY).toBe('http://proxy:3128')
    expect(seen.SLACK_TOKEN).toBeUndefined()
    expect(seen.NODE_OPTIONS).toBeUndefined()
  })

  it('validates both directions of the bundled frames strictly', () => {
    expect(bundledHostFrameSchema.safeParse({ type: 'start', providerId: 'slack', generation: 'g', config: { a: 'b' } }).success).toBe(true)
    expect(bundledHostFrameSchema.safeParse({ type: 'start', providerId: 'slack', generation: 'g', config: { a: 1 } }).success).toBe(false)
    expect(bundledWorkerFrameSchema.safeParse({ type: 'health', providerId: 'discord', generation: 'g', state: 'polling' }).success).toBe(true)
    expect(bundledWorkerFrameSchema.safeParse({ type: 'hostRequest', providerId: 'slack', generation: 'g', requestId: 'r', method: 'vault.read' }).success).toBe(false)
    expect(bundledWorkerFrameSchema.safeParse({ type: 'event', providerId: 'slack', generation: 'g', event: {} }).success).toBe(false)
  })
})
