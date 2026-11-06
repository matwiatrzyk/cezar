import { extensionRpcResponseSchema, extensionRpcReadySchema, type ExtensionRpcResponse } from '@open-mercato/cezar-contract'

export const MAX_FRAME_BYTES = 1024 * 1024
export const MAX_PENDING_CALLS = 100
export function encodeFrame(value: unknown): string {
  const frame = JSON.stringify(value)
  if (Buffer.byteLength(frame, 'utf8') > MAX_FRAME_BYTES) throw new Error('extension IPC frame exceeds 1 MiB')
  return `${frame}\n`
}
export function parseFrame(line: string): ExtensionRpcResponse | { type: 'ready'; generation: string } {
  if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) throw new Error('extension IPC frame exceeds 1 MiB')
  const raw: unknown = JSON.parse(line)
  const ready = extensionRpcReadySchema.safeParse(raw)
  if (ready.success) return ready.data
  const response = extensionRpcResponseSchema.safeParse(raw)
  if (!response.success) throw new Error('invalid extension IPC response')
  return response.data
}
