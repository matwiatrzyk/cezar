import { Hono } from 'hono';
import { z } from 'zod';
import { it, expect, vi } from 'vitest';
import { chatSchemas, chatIdentifierSchemas } from '@open-mercato/cezar-contract';
import { createChatRoutes } from './telegram.ts';
import type { ChatInbound } from '../chat/service.ts';
it('instantiates the chained route family for opaque provider IDs with middleware validation and both mounts', async () => {
 const reset = vi.fn(async () => ({ reset: true as const, inboundRevision: 'a'.repeat(64) }));
 const service = { reset } as unknown as ChatInbound;
 const family = createChatRoutes('slack', async () => service, () => undefined, chatSchemas(chatIdentifierSchemas.slack.user, chatIdentifierSchemas.slack.bot, z.string().min(1), z.string().min(1)));
 const app = new Hono().route('/api/v1', family).route('/api/v1/p/:projectId', family);
 for (const prefix of ['/api/v1', '/api/v1/p/project']) {
  const response = await app.request(`${prefix}/slack/bots/TTEAM:UBOT/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: 'a'.repeat(64), confirmReset: true }) });
  expect(response.status).toBe(200); expect(await response.json()).toEqual({ reset: true, inboundRevision: 'a'.repeat(64) });
  expect((await app.request(`${prefix}/slack/bots/TTEAM:UBOT/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(400);
 }
 expect(reset).toHaveBeenCalledTimes(2); expect(reset).toHaveBeenCalledWith('TTEAM:UBOT', 'a'.repeat(64));
});
