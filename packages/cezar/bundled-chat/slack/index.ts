import { createInterface } from 'node:readline'
import { createSlackAdapter } from '../../src/chat/providers/slack/bundled-adapter.ts'
import { bundledChatFrameSchema } from '../../src/extensions/protocol.ts'
import { z } from 'zod'

const inputSchema = z.object({ type: z.string(), providerId: z.literal('slack'), generation: z.string(), requestId: z.string().optional(), context: z.unknown().optional(), operation: z.string().optional(), input: z.unknown().optional(), cursor: z.number().int().nonnegative().optional() }).passthrough()
let generation = '', adapter: ReturnType<typeof createSlackAdapter> | undefined, running = false, cursor: number | null = null, loop: Promise<void> | undefined
function emit(value: unknown) { const parsed = bundledChatFrameSchema.safeParse(value); if (parsed.success) process.stdout.write(`${JSON.stringify(parsed.data)}\n`) }
function respond(requestId: string, ok: boolean, result?: unknown, error?: unknown) { process.stdout.write(`${JSON.stringify({ type: 'response', requestId, generation, ok, ...(ok ? { result } : { error: { message: error instanceof Error ? error.message : String(error) } }) })}\n`) }
async function receiveLoop() {
 while (running && adapter) {
  try {
   const batch = await adapter.receive(cursor)
   for (const item of batch) { if (!running) break; cursor = item.sequence; emit({ type: 'event', providerId: 'slack', generation, cursor, event: item.event }) }
   emit({ type: 'health', providerId: 'slack', generation, state: 'polling' })
  } catch { emit({ type: 'health', providerId: 'slack', generation, state: 'backoff' }) }
  await new Promise(resolve => setTimeout(resolve, 500))
 }
}
async function stop() { running = false; await loop; await adapter?.dispose?.(); adapter = undefined; emit({ type: 'health', providerId: 'slack', generation, state: 'stopped' }) }
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => { void (async () => {
 const raw = inputSchema.parse(JSON.parse(line)); if (raw.providerId !== 'slack') return
 if (raw.type === 'start') { generation = raw.generation; const context = z.record(z.string(), z.string()).parse(raw.context); const { projectId: _projectId, ...credentials } = context; adapter = createSlackAdapter(credentials); running = true; loop = receiveLoop(); emit({ type: 'health', providerId: 'slack', generation, state: 'polling' }); return }
 if (raw.generation !== generation) return
 if (raw.type === 'stop') { await stop(); return }
 if (raw.type !== 'call' || !raw.requestId || !adapter) return
 try {
  const input = raw.input ?? {}
  let result: unknown
  if (raw.operation === 'identify') result = await adapter.identify()
  else if (raw.operation === 'inspect') result = await adapter.inspect(z.object({ chatId: z.string() }).parse(input).chatId)
  else if (raw.operation === 'send') { const x = z.object({ chatId: z.string(), message: z.unknown() }).parse(input); result = await adapter.send(x.chatId, x.message as never) }
  else if (raw.operation === 'clearButtons') result = await adapter.clearButtons(input as never)
  else if (raw.operation === 'isMember') { const x = z.object({ chatId: z.string(), userId: z.string() }).parse(input); result = await adapter.isMember(x.chatId, x.userId) }
  else if (raw.operation === 'receive') result = await adapter.receive(z.number().nullable().parse((input as { after?: unknown }).after))
  else throw Error('unknown Slack operation')
  respond(raw.requestId, true, result)
 } catch (error) { respond(raw.requestId, false, undefined, error) }
 })().catch(() => undefined) })
export default { createAdapter: createSlackAdapter }
