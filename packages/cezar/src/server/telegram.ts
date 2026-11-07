import { telegramSchemas, type ChatInboundStateResponse } from '@open-mercato/cezar-contract';
import type { ChatInbound } from '../chat/service.ts';
import { createChatRoutes } from './chat-routes.ts';

/** Existing Telegram paths and typed client entry point remain unchanged. */
export function createTelegramRoutes(resolve: (projectId: string | undefined) => Promise<ChatInbound | undefined>,
  unavailable: () => ChatInboundStateResponse['reason'], validateProject?: (projectId: string | undefined) => Promise<void>) {
  return createChatRoutes('telegram', resolve, unavailable, telegramSchemas, validateProject);
}
