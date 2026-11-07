import { ChatTransportError } from '../chat/provider.ts'
import { bundledFailureSchema } from './protocol.ts'
import type { z } from 'zod'

export type BundledFailure = z.infer<typeof bundledFailureSchema>

/** A ChatTransportError keeps its failure kind across IPC; the runtime classifies on it. */
export function toBundledFailure(error: unknown): BundledFailure {
  if (error instanceof ChatTransportError) return { message: error.message.slice(0, 2000), failure: error.failure }
  return { message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) }
}

export function fromBundledFailure(value: BundledFailure | undefined): Error {
  if (value?.failure) return new ChatTransportError(value.failure)
  return new Error(value?.message ?? 'bundled provider request failed')
}
