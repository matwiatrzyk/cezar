import { chatEventSchema, type ChatEvent } from './provider.ts';
import { isChatCommand, type InputUpdate, type InputMessage } from './events.ts';
import type { InboundStateStore } from './state.ts';
/** Socket/gateway providers use opaque event IDs. Sequencing and crash deduplication belong to the core. */
export class ChatInbox {
 private tail: Promise<void> = Promise.resolve();
 constructor(private readonly state: InboundStateStore, private readonly process: (update: InputUpdate, epoch: string) => Promise<void>) {}
 accept(raw: ChatEvent): Promise<void> {
  const event = chatEventSchema.parse(raw);
  const work = this.tail.then(async () => {
   const snapshot = this.state.snapshot();
   const existing = snapshot.receivedEvents.find(row => row.id === event.id);
   if (existing) return; // A received claim is never replayed into an unaudited second effect.
   const sequence = Math.max(snapshot.nextOffset ?? 0, ...snapshot.receivedEvents.map(row => row.sequence + 1));
   await this.state.change(state => {
    state.receivedEvents.push({ id: event.id, sequence });
    state.receivedEvents = state.receivedEvents.slice(-1000);
   });
   await this.process(normalize(event, sequence), snapshot.epoch);
   await this.state.flush();
  });
  this.tail = work.catch(() => undefined); return work;
 }
 drain(): Promise<void> { return this.tail; }
}
function normalize(event: ChatEvent, sequence: number): InputUpdate {
 if (event.kind === 'membership') return { sequence, membership: { affected: [event.chat.id, ...(event.previousChatId ? [event.previousChatId] : [])], reason: event.reason === 'removed' ? 'bot_removed' : 'group_migrated' } };
 if (event.kind === 'button') return { sequence, button: { id: event.id, userId: event.user.id, chatId: event.chat.id, messageId: event.receipt.messageId, data: event.data } };
 const text = event.kind === 'start' ? `/start ${event.code}` : event.text;
 const match = /^\/([a-zA-Z0-9_]{1,32})(?:\s+([\s\S]*))?$/.exec(text);
 const command: InputMessage['command'] = match && (isChatCommand(match[1]!.toLowerCase()) || match[1] === 'start')
  ? { kind: 'command', name: match[1]!.toLowerCase(), args: match[2]?.trim() ?? '' }
  : { kind: text.startsWith('/') ? 'unknown' : 'text' };
 return { sequence, message: { id: event.kind === 'start' ? event.id : event.messageId, at: event.at,
  chat: { ...event.chat, ...(event.kind === 'start' && event.title ? { title: event.title } : {}) }, user: event.user,
  text, addressed: event.kind === 'start' || event.addressed, command,
  ...(event.kind === 'message' && event.replyTo ? { replyTo: event.replyTo.messageId } : {}) } };
}
