import { telegramSchemas } from '@open-mercato/cezar-contract';
import type { ChatBindings } from '../chat/bindings.ts';
import { createChatBindingRoutes } from './chat-routes.ts';

export function createTelegramBindingRoutes(bindings: ChatBindings) { return createChatBindingRoutes('telegram', bindings, telegramSchemas); }
