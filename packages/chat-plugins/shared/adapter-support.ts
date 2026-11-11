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
