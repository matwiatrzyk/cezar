import { Hono, type MiddlewareHandler } from 'hono';
import {
  telegramInboundIdParamSchema, telegramInboundBotParamSchema, telegramInboundActivityQuerySchema,
  telegramPairingInputSchema, telegramPairingConfirmSchema, telegramInboundReceiverPatchSchema,
  telegramInboundRevisionQuerySchema, telegramInboundResetSchema, telegramInboundGrantPatchSchema,
  telegramSetupBeginSchema, telegramSetupActivateSchema,
  type TelegramInboundStateResponse, type TelegramDomainError,
} from '@open-mercato/cezar-contract';
import { jsonZodValidator, paramZodValidator, queryZodValidator } from './validators.ts';
import { TelegramInboundFailure, type TelegramInbound } from '../telegram/service.ts';
import { BotOwnershipError } from '../telegram/ownership.ts';
import { TelegramApiError } from '../telegram/client.ts';
type TelegramEnv = { Variables: { telegram?: TelegramInbound } };
export function createTelegramRoutes(resolve: (projectId: string | undefined) => Promise<TelegramInbound | undefined>,
  unavailable: () => TelegramInboundStateResponse['reason'],
  validateProject: (projectId: string | undefined) => Promise<void> = async () => {}) {
  const domainError = (error: string, code: string): TelegramDomainError => ({ error, code });
  const gate: MiddlewareHandler<TelegramEnv> = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const projectId = c.req.param('projectId');
    await validateProject(projectId);
    if (!unavailable()) c.set('telegram', await resolve(projectId));
    if (c.req.method !== 'GET' && unavailable()) throw new TelegramInboundFailure(503, unavailable()!);
    await next();
  };
  const service = (value: TelegramInbound | undefined): TelegramInbound => {
    if (!value) throw new TelegramInboundFailure(503, unavailable() ?? 'unavailable'); return value;
  };
  return new Hono<TelegramEnv>()
    .onError((error, c) => {
      if (error instanceof TelegramInboundFailure) return c.json(domainError(error.code, error.code), error.status);
      if (error instanceof BotOwnershipError) return c.json(domainError('Bot is owned elsewhere or its binding changed.', 'bot_conflict'), 409);
      if (error instanceof TelegramApiError && error.status === 429) {
        c.header('Retry-After', String(Math.min(60, Math.max(1, error.retryAfter ?? 1))));
        return c.json(domainError('Telegram rate limit; try again later.', 'rate_limited'), 429);
      }
      if (error instanceof TelegramApiError && error.status === 401) return c.json(domainError('invalid_token', 'invalid_token'), 401);
      return c.json(domainError('Telegram is temporarily unavailable.', 'unavailable'), 503);
    })
    .use('/telegram', gate).use('/telegram/*', gate)
    .get('/telegram', async c => {
      const inbound = c.get('telegram');
      await inbound?.refreshDiagnostics();
      const reason = unavailable();
      // Configuration is sensitive enough to withhold whenever inbound is not usable.
      // The availability explanation remains readable so the cockpit can explain why.
      const result: TelegramInboundStateResponse = reason || !inbound
        ? { available: false, ...(reason ? { reason } : { reason: 'unavailable' as const }), receivers: [], bots: [], grants: [] }
        : inbound.list();
      return c.json(result);
    })
    // Hosted or flag-off: reads answer empty, never the stored journal or pairing state.
    .get('/telegram/activity', queryZodValidator(telegramInboundActivityQuerySchema), c => {
      const inbound = c.get('telegram');
      return c.json(unavailable() || !inbound ? { entries: [] } : inbound.activity(c.req.valid('query')));
    })
    .post('/telegram/pairings', jsonZodValidator(telegramPairingInputSchema), async c => c.json(await service(c.get('telegram')).pair(c.req.valid('json')), 201))
    .post('/telegram/setup', jsonZodValidator(telegramSetupBeginSchema), async c => c.json(await service(c.get('telegram')).beginSetup(c.req.valid('json')), 201))
    .get('/telegram/setup/:id', paramZodValidator(telegramInboundIdParamSchema), c => c.json(service(c.get('telegram')).setupStatus(c.req.valid('param').id)))
    .post('/telegram/setup/:id/activate', paramZodValidator(telegramInboundIdParamSchema), jsonZodValidator(telegramSetupActivateSchema), async c => c.json(await service(c.get('telegram')).activateSetup(c.req.valid('param').id, c.req.valid('json'))))
    .get('/telegram/pairings/:id', paramZodValidator(telegramInboundIdParamSchema), c => {
      const inbound = c.get('telegram');
      if (unavailable() || !inbound) throw new TelegramInboundFailure(404, 'pairing_expired');
      return c.json(inbound.pairing(c.req.valid('param').id));
    })
    .post('/telegram/pairings/:id/confirm', paramZodValidator(telegramInboundIdParamSchema), jsonZodValidator(telegramPairingConfirmSchema), async c => c.json(await service(c.get('telegram')).confirm(c.req.valid('param').id, c.req.valid('json'))))
    .delete('/telegram/pairings/:id', paramZodValidator(telegramInboundIdParamSchema), c => c.json(service(c.get('telegram')).cancelPairing(c.req.valid('param').id)))
    .patch('/telegram/receivers/:id', paramZodValidator(telegramInboundIdParamSchema), jsonZodValidator(telegramInboundReceiverPatchSchema), async c => c.json(await service(c.get('telegram')).setEnabled(c.req.valid('param').id, c.req.valid('json'))))
    .patch('/telegram/grants/:id', paramZodValidator(telegramInboundIdParamSchema), jsonZodValidator(telegramInboundGrantPatchSchema), async c => c.json(await service(c.get('telegram')).permissions(c.req.valid('param').id, c.req.valid('json'))))
    .delete('/telegram/grants/:id', paramZodValidator(telegramInboundIdParamSchema), queryZodValidator(telegramInboundRevisionQuerySchema), async c => c.json(await service(c.get('telegram')).revoke(c.req.valid('param').id, c.req.valid('query').expectedRevision)))
    .delete('/telegram/bots/:botId/binding', paramZodValidator(telegramInboundBotParamSchema), queryZodValidator(telegramInboundRevisionQuerySchema), async c => c.json(await service(c.get('telegram')).disconnect(c.req.valid('param').botId, c.req.valid('query').expectedRevision)))
    .post('/telegram/bots/:botId/reset', paramZodValidator(telegramInboundBotParamSchema), jsonZodValidator(telegramInboundResetSchema), async c => c.json(await service(c.get('telegram')).reset(c.req.valid('param').botId, c.req.valid('json').expectedRevision)))
    .all('/telegram/*', c => c.json(domainError('Unknown Telegram route.', 'not_found'), 404));
}
