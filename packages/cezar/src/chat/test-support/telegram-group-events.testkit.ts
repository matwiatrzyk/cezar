import { processGroupEvent as process } from '../group-events.ts';
import { normalizeUpdate } from './telegram-wire.testkit.ts';
import type { TelegramUpdate } from './telegram-wire.testkit.ts';
import type { InboundStateStore } from '../state.ts';
export const processGroupEvent = (store: InboundStateStore, update: TelegramUpdate, epoch: string) => process(store, normalizeUpdate(update, ''), epoch);
