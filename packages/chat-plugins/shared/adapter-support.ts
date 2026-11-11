// Helpers every shipped adapter shares. Symlinked into each plugin's src so its artifact stays
// self-contained; node built-ins only, it resolves from any plugin.
import { pinnedConnect, type Address } from './pinned-request.js'

type PooledAgent = { close(): Promise<unknown> }
const POOL_SIZE = 4

/** A reply must not pay a TLS handshake per call; each agent stays pinned to its validated address. */
export function agentPool<A extends PooledAgent>(Agent: new (options: { connections: number; pipelining: number; connect: ReturnType<typeof pinnedConnect> }) => A): (target: Address) => A {
 const agents = new Map<string, A>()
 return target => {
  const key = `${target.family}/${target.address}`
  const known = agents.get(key)
  if (known) return known
  const agent = new Agent({ connections: 4, pipelining: 1, connect: pinnedConnect(target) })
  agents.set(key, agent)
  for (const [stale, old] of agents) if (agents.size > POOL_SIZE && stale !== key) { agents.delete(stale); void old.close().catch(() => undefined) }
  return agent
 }
}

// A timer over 2^31-1 ms fires at once, so a longer wait sleeps in chunks.
const MAX_TIMER_MS = 2 ** 31 - 1
// Wide enough for AbortSignal and the SDK's narrower operation signal.
type DelaySignal = { readonly aborted: boolean; addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void; removeEventListener(type: 'abort', listener: () => void): void }
function sleep(ms: number, signal: DelaySignal): Promise<void> {
 return new Promise(resolve => {
  const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
  const timer = setTimeout(done, ms)
  signal.addEventListener('abort', done, { once: true })
  if (signal.aborted) done()
 })
}
/** Resolves after `ms`, or as soon as `signal` aborts; never rejects. */
export async function abortableDelay(ms: number, signal: DelaySignal): Promise<void> {
 for (let left = ms; left > 0 && !signal.aborted; left -= MAX_TIMER_MS) await sleep(Math.min(left, MAX_TIMER_MS), signal)
}

/** A Retry-After in seconds as milliseconds; a missing or unusable value waits five seconds. */
export function retryAfterMs(value: unknown, capSeconds = Infinity): number {
 const seconds = Number(Array.isArray(value) ? value[0] : value)
 return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, capSeconds) * 1000 : 5000
}

/** Insert as newest, evicting the oldest entry past `limit`. */
export function remember<V>(map: Map<string, V>, key: string, value: V, limit: number): void {
 map.delete(key)
 map.set(key, value)
 if (map.size > limit) map.delete(map.keys().next().value!)
}
