// Host owner of one bundled Slack/Discord worker (spec 2026-11-07-bundled-chat-workers): a
// ChatTransport facade over the worker, restart with bounded backoff on a crash, and a per-provider
// fall-back to the in-process compatibility transport once restarts are exhausted.
import { z } from 'zod'
import { ChatTransportError, chatEventSchema, type ChatTransport } from '../chat/provider.ts'
import type { ChatConnection, ChatConnectionOptions, ChatHealth, ReceiveJournal } from '../chat/connection.ts'
import { startBundledProvider, type BundledProviderContext, type BundledProviderHandle } from './bundled-runtime.ts'
import type { BundledProviderManifest } from './bundled-catalog.ts'

export interface BundledChatOwnerOptions {
  manifest: BundledProviderManifest
  packageRoot: string
  /** Worker start configuration; re-read on every (re)spawn. */
  config(): Promise<Record<string, string>>
  /** The in-process adapter: the fall-back owner, never started alongside a live worker. */
  compatibility: ChatTransport
  /** Slack only: rotate one access token with host-held refresh credentials. */
  rotate?(kind: 'app' | 'bot', signal: AbortSignal): Promise<string>
  log?(line: string): void
  /** Consecutive crashes (each within a minute of its spawn) tolerated before falling back. */
  maxRestarts?: number
  restartDelayMs?(attempt: number): number
  worker?: Pick<BundledProviderContext, 'execArgv' | 'env' | 'readyTimeoutMs' | 'callTimeoutMs' | 'stopTimeoutMs'>
}
type Live = { journal: ReceiveJournal; options: ChatConnectionOptions; now?: () => number }
const nativeInput = z.object({ query: z.string().max(128), chatId: z.string().max(512), userId: z.string().max(256) }).strict()
const rotateInput = z.object({ kind: z.enum(['app', 'bot']) }).strict()
const blocked = () => new ChatTransportError({ kind: 'blocked' })

export class BundledChatOwner {
  private worker?: BundledProviderHandle
  private live?: Live
  private fallback?: ChatConnection
  private state: ChatHealth = { state: 'stopped' }
  private stopped = false
  private crashes = 0
  private spawnedAt = 0
  private timer?: ReturnType<typeof setTimeout>
  private respawning?: Promise<void>
  mode: 'worker' | 'compatibility' = 'worker'

  private constructor(private readonly options: BundledChatOwnerOptions) {}

  /** Resolves with a ready worker, or rejects so the caller keeps the compatibility owner. */
  static async activate(options: BundledChatOwnerOptions): Promise<BundledChatOwner> {
    const owner = new BundledChatOwner(options)
    owner.worker = await owner.spawn()
    return owner
  }

  get pid(): number | undefined { return this.worker?.process.pid }
  private get id() { return this.options.manifest.id }
  private log(line: string) { (this.options.log ?? (value => console.warn(value)))(`[chat] bundled ${this.id} worker: ${line}`) }

  private async spawn(): Promise<BundledProviderHandle> {
    this.spawnedAt = Date.now()
    return startBundledProvider(this.options.manifest, {
      ...this.options.worker,
      packageRoot: this.options.packageRoot,
      config: await this.options.config(),
      log: line => this.log(line),
      onHealth: state => this.health({ state }),
      onExit: error => this.crashed(error),
      onHostRequest: (method, params, signal) => this.serve(method, params, signal),
    })
  }

  private health(value: ChatHealth) {
    this.state = value.state === 'polling' ? { ...value, lastSuccessfulPollAt: Date.now() } : value
    if (this.live && this.mode === 'worker') this.live.options.onHealth(this.state)
  }

  private async serve(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const live = this.live
    if (method === 'rotate') {
      if (!this.options.rotate) throw new ChatTransportError({ kind: 'auth' })
      return { token: await this.options.rotate(rotateInput.parse(params).kind, signal) }
    }
    if (!live || this.stopped) throw blocked()
    if (method === 'assertCredentials') { await live.options.assertCredentials(); return undefined }
    if (method === 'accept') { await live.options.accept(chatEventSchema.parse(z.object({ event: z.unknown() }).strict().parse(params).event)); return undefined }
    if (method === 'nativeTasks') {
      const input = nativeInput.parse(params)
      return await live.options.nativeCommands?.tasks(input.query, input.chatId, input.userId) ?? []
    }
    throw blocked()
  }

  private crashed(error: Error) {
    this.worker = undefined
    if (this.stopped || this.mode !== 'worker') return
    // A worker that lived a minute is healthy again; only rapid crash loops count toward fall-back.
    this.crashes = Date.now() - this.spawnedAt < 60_000 ? this.crashes + 1 : 1
    if (this.crashes > (this.options.maxRestarts ?? 3)) { this.degrade(`${error.message}; restarts exhausted, using the in-process adapter`); return }
    this.log(`${error.message}; restarting (attempt ${this.crashes})`)
    this.health({ state: 'backoff' })
    const wait = this.options.restartDelayMs?.(this.crashes) ?? Math.min(30_000, 1_000 * 2 ** (this.crashes - 1))
    this.timer = setTimeout(() => { this.timer = undefined; this.respawning = this.respawn() }, wait)
    this.timer.unref()
  }

  private async respawn() {
    if (this.stopped || this.mode !== 'worker') return
    try {
      const worker = await this.spawn()
      if (this.stopped || this.mode !== 'worker') { await worker.stop(); return }
      this.worker = worker
      if (this.live) worker.connect()
    } catch (error) { this.crashed(error instanceof Error ? error : new Error('respawn failed')) }
  }

  /** Per-provider fail-open: the dead worker is gone before the in-process connection starts. */
  private degrade(reason: string) {
    this.mode = 'compatibility'
    this.log(reason)
    const worker = this.worker; this.worker = undefined
    void worker?.stop()
    if (this.live && !this.stopped) {
      this.fallback = this.options.compatibility.connect(this.live.journal, this.live.options, this.live.now)
      this.fallback.start()
    }
  }

  private async call(operation: Parameters<BundledProviderHandle['call']>[0], input: unknown, valid: () => boolean, signal?: AbortSignal): Promise<unknown> {
    if (this.stopped || !valid() || signal?.aborted) throw blocked()
    // While a crashed worker restarts, callers see a retryable failure rather than a hang.
    if (!this.worker) throw new ChatTransportError({ kind: 'transient' })
    return this.worker.call(operation, input, { valid, ...(signal ? { signal } : {}) })
  }

  /** The runtime's transport. Each operation goes to the worker, or to compatibility after fall-back. */
  transport(valid: () => boolean): ChatTransport {
    const compat = () => this.options.compatibility.guarded(valid)
    const owner = this
    return {
      identify: signal => owner.mode === 'worker' ? owner.call('identify', {}, valid, signal) as never : compat().identify(signal),
      inspect: chatId => owner.mode === 'worker' ? owner.call('inspect', { chatId }, valid) as never : compat().inspect(chatId),
      send: (chatId, message, signal, guard) => owner.mode === 'worker' ? owner.call('send', { chatId, message }, () => valid() && (!guard || guard()), signal) as never : compat().send(chatId, message, signal, guard),
      clearButtons: (receipt, signal) => owner.mode === 'worker' ? owner.call('clearButtons', receipt, valid, signal).then(() => undefined) : compat().clearButtons(receipt, signal),
      acknowledge: (eventId, text, signal) => owner.mode === 'worker' ? owner.call('acknowledge', { eventId, text }, valid, signal).then(() => undefined) : compat().acknowledge(eventId, text, signal),
      isMember: (chatId, userId, signal) => owner.mode === 'worker' ? owner.call('isMember', { chatId, userId }, valid, signal) as never : compat().isMember(chatId, userId, signal),
      guarded: check => owner.transport(() => valid() && check()),
      connect: (journal, options, now): ChatConnection => ({
        start() {
          if (owner.stopped || owner.live) return
          owner.live = { journal, options, ...(now ? { now } : {}) }
          if (owner.mode === 'compatibility') { owner.fallback = owner.options.compatibility.connect(journal, options, now); owner.fallback.start() }
          else owner.worker?.connect()
        },
        health: () => owner.fallback?.health() ?? owner.state,
        async stop() { await owner.disconnect() },
      }),
    }
  }

  private async disconnect() {
    this.live = undefined
    try { this.worker?.disconnect() } catch { /* gone */ }
    const fallback = this.fallback; this.fallback = undefined
    await fallback?.stop()
    this.state = { state: 'stopped' }
  }

  /** Stops the receive connection first, then the worker (SIGTERM, then SIGKILL, bounded). */
  async stop(): Promise<void> {
    if (this.stopped) return
    await this.disconnect()
    this.stopped = true
    clearTimeout(this.timer)
    await this.respawning
    const worker = this.worker; this.worker = undefined
    await worker?.stop()
  }
}
