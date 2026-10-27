import { hc, type InferRequestType, type InferResponseType } from 'hono/client';
import { expect, it } from 'vitest';
import type { z } from 'zod';
import type {
  telegramInboundStateResponseSchema, telegramInboundActivityResponseSchema, telegramPairingCreatedSchema,
  telegramPairingStatusSchema, telegramPairingConfirmedSchema, telegramPairingCancelledSchema,
  telegramInboundReceiverPatchedSchema, telegramInboundRevokedSchema, telegramInboundDisconnectedSchema,
  telegramInboundResetResponseSchema, telegramPairingInputSchema, telegramOrphanBindingsSchema, telegramOrphanReleasedSchema,
} from '@open-mercato/cezar-contract';
import type { AppType } from './app-type.ts';
const client = hc<AppType>('http://127.0.0.1');
const routes = client.api.v1.p[':projectId']['telegram'];
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : 'route-wider') : 'schema-wider';
type Assert<T extends true> = T;
type Checks = [
  Assert<Equal<z.infer<typeof telegramPairingConfirmedSchema>, InferResponseType<typeof routes.grants[':id']['$patch'], 200>>>,
  Assert<Equal<z.infer<typeof telegramOrphanBindingsSchema>, InferResponseType<typeof client.api.v1.telegram['bot-bindings']['$get'], 200>>>,
  Assert<Equal<z.infer<typeof telegramOrphanReleasedSchema>, InferResponseType<typeof client.api.v1.telegram['bot-bindings'][':botId']['$delete'], 200>>>,
  Assert<Equal<z.infer<typeof telegramInboundStateResponseSchema>, InferResponseType<typeof routes.$get, 200>>>,
  Assert<Equal<z.infer<typeof telegramInboundActivityResponseSchema>, InferResponseType<typeof routes.activity.$get, 200>>>,
  Assert<Equal<z.infer<typeof telegramPairingCreatedSchema>, InferResponseType<typeof routes.pairings.$post, 201>>>,
  Assert<Equal<z.infer<typeof telegramPairingStatusSchema>, InferResponseType<typeof routes.pairings[':id']['$get'], 200>>>,
  Assert<Equal<z.infer<typeof telegramPairingConfirmedSchema>, InferResponseType<typeof routes.pairings[':id']['confirm']['$post'], 200>>>,
  Assert<Equal<z.infer<typeof telegramPairingCancelledSchema>, InferResponseType<typeof routes.pairings[':id']['$delete'], 200>>>,
  Assert<Equal<z.infer<typeof telegramInboundReceiverPatchedSchema>, InferResponseType<typeof routes.receivers[':id']['$patch'], 200>>>,
  Assert<Equal<z.infer<typeof telegramInboundRevokedSchema>, InferResponseType<typeof routes.grants[':id']['$delete'], 200>>>,
  Assert<Equal<z.infer<typeof telegramInboundDisconnectedSchema>, InferResponseType<typeof routes.bots[':botId']['binding']['$delete'], 200>>>,
  Assert<Equal<z.infer<typeof telegramInboundResetResponseSchema>, InferResponseType<typeof routes.bots[':botId']['reset']['$post'], 200>>>,
  Assert<Equal<z.input<typeof telegramPairingInputSchema>, InferRequestType<typeof routes.pairings.$post>['json']>>,
  Assert<Equal<InferResponseType<typeof routes.$get, 200>, InferResponseType<typeof client.api.v1.telegram.$get, 200>>>,
];
it('enforces Telegram response parity and typed request bodies', () => { expect(true).toBe(true); });
