// One supervisor for every worker process cezar spawns: bundled Telegram/Slack/Discord workers and user
// extensions. It owns only the process plumbing — env policy, line framing, stderr drain, hung
// detection, bounded stop and restart budgets. Each host keeps its own frame protocol (protocol.ts).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { encodeFrame, MAX_FRAME_BYTES } from './rpc.ts'

// Network-relevant variables only: never PATH, HOME, credentials or NODE_OPTIONS (#F10).
const FORWARDED_ENV = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'NODE_USE_ENV_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
]

export function workerEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = { NODE_ENV: 'production' }
  for (const key of FORWARDED_ENV) {
    const value = env[key]
    if (typeof value === 'string') out[key] = value
  }
  return out
}

/** A live worker that times out this many calls in a row is hung and gets killed (N4). */
export const HUNG_AFTER_TIMEOUTS = 3
const STDERR_LINES_PER_MINUTE = 50
const STDERR_LINE_CHARS = 500
const STDERR_TAIL_CHARS = 4096
const TERM_WAIT_MS = 2_000

export interface WorkerProcessOptions {
  /** Prefix for log lines, e.g. `[bundled slack]`. */
  label: string
  /** Arguments after `process.execPath`. */
  args: readonly string[]
  cwd: string
  /** The environment the allowlist reads from (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv
  log(line: string): void
  /** Forward a rate-capped sample of stderr lines to `log`; the tail is kept either way. */
  forwardStderr?: boolean
  /** One parsed JSON line. Throwing is a protocol error: the worker is killed. */
  onFrame(frame: unknown): void
  /** Called exactly once, when the process is gone (including after `stop`). */
  onExit(error: Error): void
}

export interface WorkerProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly alive: boolean
  readonly exited: Promise<void>
  /** True while stdin is backed up; the caller decides whether to drop or wait. */
  readonly congested: boolean
  /** Encode one frame (1 MiB cap) and write it; throws when the process is gone or the frame is oversized. */
  write(frame: unknown): void
  kill(reason?: string): void
  /** Count a timed-out call; the third in a row kills the worker. */
  timedOut(): void
  /** Any answer from the worker proves it is not hung. */
  answered(): void
  /** The last few KiB of stderr, for an exit diagnostic. */
  stderrTail(): string
  /** Wait `graceMs` for a voluntary exit, then SIGTERM, then SIGKILL — bounded either way. */
  stop(graceMs: number): Promise<void>
}

export function spawnWorkerProcess(options: WorkerProcessOptions): WorkerProcess {
  const child = spawn(process.execPath, [...options.args], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: workerEnv(options.env),
  })
  let alive = true
  let timeouts = 0
  let tail = ''
  let exited!: () => void
  const exit = new Promise<void>(done => { exited = done })

  const finish = (error: Error) => {
    if (!alive) return
    alive = false
    exited()
    options.onExit(error)
  }
  const kill = (reason?: string) => {
    if (reason) options.log(`${options.label} ${reason}; killing worker`)
    if (alive) child.kill('SIGKILL')
  }

  child.once('error', error => finish(error))
  child.once('exit', (code, signal) => finish(new Error(`${options.label} worker exited (${code ?? signal ?? 'unknown'})`)))
  child.stdin.on('error', () => kill())
  drainStderr(child, options, line => { tail = `${tail}${line}\n`.slice(-STDERR_TAIL_CHARS) })
  readFrames(child, frame => options.onFrame(frame), reason => kill(`protocol error: ${reason}`))

  const wait = (ms: number) => Promise.race([
    exit.then(() => true),
    new Promise<boolean>(done => { setTimeout(() => done(false), ms).unref() }),
  ])

  return {
    child,
    exited: exit,
    get alive() { return alive },
    get congested() { return child.stdin.writableNeedDrain },
    write(frame) {
      if (!alive || !child.stdin.writable) throw new Error(`${options.label} worker IPC closed`)
      child.stdin.write(encodeFrame(frame))
    },
    kill,
    timedOut() {
      if (++timeouts >= HUNG_AFTER_TIMEOUTS && alive) kill(`${timeouts} calls timed out in a row`)
    },
    answered() { timeouts = 0 },
    stderrTail: () => tail.trim(),
    async stop(graceMs) {
      if (!alive) return
      if (graceMs > 0 && await wait(graceMs)) return
      child.kill('SIGTERM')
      if (await wait(TERM_WAIT_MS)) return
      child.kill('SIGKILL')
      await wait(TERM_WAIT_MS)
    },
  }
}

/** Newline-delimited JSON with a hard per-frame cap, enforced before a line is complete. */
function readFrames(child: ChildProcessWithoutNullStreams, onFrame: (frame: unknown) => void, fail: (reason: string) => void) {
  let buffer = Buffer.alloc(0)
  let failed = false
  child.stdout.on('data', (chunk: Buffer) => {
    if (failed) return
    buffer = Buffer.concat([buffer, chunk])
    try {
      let end: number
      while ((end = buffer.indexOf(10)) !== -1) {
        if (end > MAX_FRAME_BYTES) throw new Error('frame exceeds 1 MiB')
        const line = buffer.subarray(0, end).toString('utf8')
        buffer = buffer.subarray(end + 1)
        let raw: unknown
        try { raw = JSON.parse(line) } catch { throw new Error('invalid JSON frame') }
        onFrame(raw)
      }
      if (buffer.length > MAX_FRAME_BYTES) throw new Error('frame exceeds 1 MiB')
    } catch (error) {
      failed = true
      buffer = Buffer.alloc(0)
      fail(error instanceof Error ? error.message : 'invalid frame')
    }
  })
}

/** Always drain stderr, so a chatty worker never blocks on a full pipe. */
function drainStderr(child: ChildProcessWithoutNullStreams, options: WorkerProcessOptions, keep: (line: string) => void) {
  let partial = ''
  let window = { start: Date.now(), count: 0 }
  const line = (text: string) => {
    const clipped = text.slice(0, STDERR_LINE_CHARS)
    keep(clipped)
    if (!options.forwardStderr) return
    if (Date.now() - window.start >= 60_000) window = { start: Date.now(), count: 0 }
    if (++window.count <= STDERR_LINES_PER_MINUTE) options.log(`${options.label} ${clipped}`)
  }
  child.stderr.on('data', (chunk: Buffer) => {
    const lines = `${partial}${chunk.toString('utf8')}`.split(/\r?\n/)
    partial = lines.pop()!.slice(0, STDERR_LINE_CHARS)
    for (const text of lines) line(text)
  })
  child.stderr.on('end', () => { if (partial) line(partial) })
}

export interface RestartBudgetOptions {
  /** Consecutive rapid crashes tolerated before giving up. */
  maxRestarts?: number
  delayMs?(attempt: number): number
}

/** Bounded restart with backoff. A worker that lived a minute is healthy again; only rapid crash
 *  loops count toward giving up. */
export class RestartBudget {
  private crashes = 0
  constructor(private readonly options: RestartBudgetOptions = {}) {}

  /** The next attempt and its delay, or undefined once restarts are exhausted. */
  crashed(spawnedAt: number, now = Date.now()): { attempt: number; delayMs: number } | undefined {
    this.crashes = now - spawnedAt < 60_000 ? this.crashes + 1 : 1
    if (this.crashes > (this.options.maxRestarts ?? 3)) return undefined
    const delayMs = this.options.delayMs?.(this.crashes) ?? Math.min(30_000, 1_000 * 2 ** (this.crashes - 1))
    return { attempt: this.crashes, delayMs }
  }

  reset() { this.crashes = 0 }
}
