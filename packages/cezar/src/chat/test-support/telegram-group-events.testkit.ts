import { processGroupEvent as process } from '../group-events.ts';
import { normalizeUpdate } from '../providers/telegram/normalize.ts';
import type { TelegramUpdate } from '../providers/telegram/protocol.ts';
import type { InboundStateStore } from '../state.ts';
export const processGroupEvent = (store: InboundStateStore, update: TelegramUpdate, epoch: string) => process(store, normalizeUpdate(update, ''), epoch);
