import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { bundledChatFrameSchema, type BundledChatFrame } from './protocol.ts'
import { encodeFrame, MAX_FRAME_BYTES } from './rpc.ts'
import type { BundledProviderManifest } from './bundled-catalog.ts'

export type BundledProviderContext = {
  projectId: string
  /** Package root used to resolve the catalog's provider-relative entry. */
  packageRoot?: string
  generation?: string
  onFrame?: (frame: BundledChatFrame) => Promise<void> | void
  onCrash?: (error: Error) => void
  /** Values are copied into the worker start frame; no host objects cross IPC. */
  values?: Record<string, unknown>
  /** Delay the start frame until the host has installed its receive callback. */
  start?: boolean
}
export type BundledProviderHandle = {
  readonly providerId: string
  readonly generation: string
  readonly process?: ChildProcessWithoutNullStreams
  send(type: string, value?: unknown): void
  call(type: string, value?: unknown): Promise<unknown>
  start(): void
  stop(): Promise<void>
}

/** Ignore frames from a worker generation which has already been fenced. */
export function acceptBundledFrame(frame: unknown, generation: string, onFrame: (frame: BundledChatFrame) => void): boolean {
  const parsed = bundledChatFrameSchema.safeParse(frame)
  if (!parsed.success || parsed.data.generation !== generation) return false
  onFrame(parsed.data)
  return true
}

export async function startBundledProvider(manifest: BundledProviderManifest, context: BundledProviderContext): Promise<BundledProviderHandle> {
  const generation = context.generation ?? randomUUID()
  const entry = context.packageRoot ? resolve(context.packageRoot, 'dist', 'bundled-chat', manifest.id, manifest.entry) : manifest.entry
  const child = spawn(process.execPath, [entry], { cwd: dirname(entry), stdio: ['pipe', 'pipe', 'pipe'], env: { NODE_ENV: 'production' } })
  let stopping = false
  let settled!: () => void
  const exit = new Promise<void>(resolve => { settled = resolve })
  let buffer = Buffer.alloc(0)
  let requestSequence = 0
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  const fail = (error: Error) => { if (!stopping) context.onCrash?.(error) }
  child.once('error', error => { fail(error); settled() })
  child.once('exit', code => { if (!stopping) fail(Error(`bundled provider exited (${code ?? 'signal'})`)); settled() })
  child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    let end: number
    try {
      while ((end = buffer.indexOf(10)) !== -1) {
        if (end > MAX_FRAME_BYTES) throw Error('bundled provider frame exceeds 1 MiB')
        const raw = JSON.parse(buffer.subarray(0, end).toString('utf8'))
        buffer = buffer.subarray(end + 1)
        if (raw?.type === 'response' && raw?.generation === generation && typeof raw.requestId === 'string') {
          const request = pending.get(raw.requestId); if (request) { pending.delete(raw.requestId); raw.ok ? request.resolve(raw.result) : request.reject(Error(raw.error?.message ?? 'bundled provider request failed')) }
        } else acceptBundledFrame(raw, generation, frame => { void context.onFrame?.(frame) })
      }
      if (buffer.length > MAX_FRAME_BYTES) throw Error('bundled provider frame exceeds 1 MiB')
    } catch (error) { fail(error instanceof Error ? error : Error('invalid bundled provider frame')); child.kill('SIGKILL') }
  })
  const handle: BundledProviderHandle = {
    providerId: manifest.id, generation, process: child,
    send: (type, value) => {
      if (stopping) throw Error('bundled provider stopped')
      child.stdin.write(encodeFrame({ type, providerId: manifest.id, generation, ...(value && typeof value === 'object' ? value : { value }) }))
    },
    call: (type, value) => new Promise((resolve, reject) => {
      const requestId = `bundled-${++requestSequence}`
      pending.set(requestId, { resolve, reject })
      try { child.stdin.write(encodeFrame({ type: 'call', requestId, providerId: manifest.id, generation, ...(value && typeof value === 'object' ? value : { value }) })) }
      catch (error) { pending.delete(requestId); reject(error instanceof Error ? error : Error('bundled provider request failed')) }
    }),
    start: () => {
      if (stopping) throw Error('bundled provider stopped')
      child.stdin.write(encodeFrame({ type: 'start', providerId: manifest.id, generation, context: { projectId: context.projectId, ...(context.values ?? {}) } }))
    },
    stop: async () => {
      if (stopping) return exit
      stopping = true
      try { child.stdin.write(encodeFrame({ type: 'stop', providerId: manifest.id, generation })) } catch { /* process may already be gone */ }
      const timer = setTimeout(() => child.kill('SIGTERM'), 5_000)
      timer.unref()
      await exit
      clearTimeout(timer)
      for (const request of pending.values()) request.reject(Error('bundled provider stopped'))
      pending.clear()
    },
  }
  if (context.start !== false) handle.start()
  return handle
}
