import { hc, type InferResponseType } from 'hono/client'
import { describe, expect, it } from 'vitest'
import type { z } from 'zod'
import {
  extensionActionResponseSchema,
  extensionManifestSchema,
  extensionMutationResponseSchema,
  extensionPanelsResponseSchema,
  extensionPrepareInstallResponseSchema,
  extensionRecordSchema,
} from '@open-mercato/cezar-contract'
import type { AppType } from './app-type.ts'

type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-is-wider') : 'schema-is-wider'
type Assert<T extends true> = T
const client = hc<AppType>('http://127.0.0.1')
const extensions = client.api.v1.p[':projectId'].extensions
const extensionActions = extensions[':extensionId'].actions
const extensionDelete = extensions[':extensionId']

type Checks = [
  Assert<Mutual<z.infer<typeof extensionPanelsResponseSchema>, InferResponseType<typeof extensions.panels.$get, 200>>>,
  Assert<Mutual<z.infer<typeof extensionPrepareInstallResponseSchema>, InferResponseType<typeof extensions['prepare-install']['$post'], 200>>>,
  Assert<Mutual<z.infer<typeof extensionRecordSchema>, InferResponseType<typeof extensions.$post, 201>>>,
  Assert<Mutual<z.infer<typeof extensionActionResponseSchema>, InferResponseType<typeof extensionActions.$post, 200>>>,
  Assert<Mutual<z.infer<typeof extensionMutationResponseSchema>, InferResponseType<typeof extensionDelete.$delete, 200>>>,
]
const checked: Checks | undefined = undefined
void checked

describe('extension HTTP contract parity', () => {
  it('keeps the extension manifest schema usable at runtime', () => {
    expect(extensionManifestSchema.parse({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs' }).permissions).toEqual([])
  })
})
