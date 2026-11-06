import { Hono } from 'hono';
import { telegramSchemas, type chatSchemas, type TelegramDomainError } from '@open-mercato/cezar-contract';
import { paramZodValidator, queryZodValidator } from './validators.ts';
import { ChatBindings } from '../chat/bindings.ts';
import { ChatInboundFailure } from './telegram-service.ts';
import { BotOwnershipError } from '../chat/ownership.ts';
/** Exact workspace paths only, before the project's /telegram/* catch-all. */
export function createChatBindingRoutes<const P extends string>(provider: P, bindings: ChatBindings | ((params: Record<string, string>) => ChatBindings), schemas: ReturnType<typeof chatSchemas>) {
  const domainError = (error: string, code: string): TelegramDomainError => ({ error, code });
  return new Hono()
    .onError((error, c) => {
      if (error instanceof ChatInboundFailure) return c.json(domainError(error.code, error.code), error.status);
      if (error instanceof BotOwnershipError) return c.json(domainError('Bot has an active owner or a changed binding.', 'bot_conflict'), 409);
      return c.json(domainError('Bot bindings are temporarily unavailable.', 'unavailable'), 503);
    })
    .get(`/${provider}/bot-bindings` as const, async c => { c.header('Cache-Control', 'no-store'); return c.json(await (typeof bindings === 'function' ? bindings(Object.fromEntries(Object.entries(c.req.param()).map(([key, value]) => [key, String(value)]))) : bindings).list()); })
    .delete(`/${provider}/bot-bindings/:botId` as const, paramZodValidator(schemas.telegramInboundBotParamSchema), queryZodValidator(schemas.telegramOrphanReleaseQuerySchema), async c => {
      c.header('Cache-Control', 'no-store'); return c.json(await (typeof bindings === 'function' ? bindings(Object.fromEntries(Object.entries(c.req.param()).map(([key, value]) => [key, String(value)]))) : bindings).release(c.req.valid('param').botId, c.req.valid('query').expectedRevision));
    });
}

export function createTelegramBindingRoutes(bindings: ChatBindings) { return createChatBindingRoutes('telegram', bindings, telegramSchemas); }
