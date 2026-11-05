import { chatEventSchema, chatFailureSchema, chatIdentitySchema, chatMessageSchema, chatReceiptSchema, type ChatEvent, type ChatTransport } from '../chat/provider.ts';
import { chatExtensionRequestSchema, type ChatExtensionRequest } from '@open-mercato/cezar-contract';
import type { ChatConnection, ChatConnectionOptions, ReceiveJournal } from '../chat/connection.ts';
import { ChatTransportError } from '../chat/provider.ts';
import { z } from 'zod';

export type ChatExtensionOperation = import('@open-mercato/cezar-contract').ChatExtensionOperation;
export type ChatExtensionInvoke = (request: ChatExtensionRequest, signal?: AbortSignal) => Promise<unknown>;

/** Turns the serializable extension RPC into the core's authenticated transport.
 * Generation and validity are checked immediately before every effect, including
 * adapter receives. A stale extension can therefore never send after disable. */
export class ChatExtensionBridge implements ChatTransport {
  private readonly generation: string;
  constructor(private readonly invoke: ChatExtensionInvoke, generation: string, private readonly valid: () => boolean = () => true) { this.generation = generation; }
  private async call(operation: ChatExtensionOperation, input: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.valid() || signal?.aborted) throw new ChatTransportError({ kind: 'blocked' });
    try {
      const result = await this.invoke(chatExtensionRequestSchema.parse({ operation, generation: this.generation, input }), signal);
      if (!this.valid() || signal?.aborted) throw new ChatTransportError({ kind: 'blocked' });
      return result;
    } catch (error) {
      if (error instanceof ChatTransportError) throw error;
      const parsed = chatFailureSchema.safeParse(error && typeof error === 'object' && 'failure' in error ? (error as { failure: unknown }).failure : undefined);
      throw new ChatTransportError(parsed.success ? parsed.data : { kind: 'transient' });
    }
  }
  async identify(signal?: AbortSignal) { return chatIdentitySchema.parse(await this.call('identify', {}, signal)); }
  async inspect(chatId: string, signal?: AbortSignal) { return z.object({ id: z.string(), kind: z.enum(['private', 'group']), eligible: z.boolean() }).parse(await this.call('inspect', { chatId }, signal)); }
  async send(chatId: string, message: import('../chat/provider.ts').ChatMessage, signal?: AbortSignal, valid?: () => boolean) {
    if (valid && !valid()) throw new ChatTransportError({ kind: 'blocked' });
    return chatReceiptSchema.parse(await this.call('send', { chatId, message: chatMessageSchema.parse(message) }, signal));
  }
  async clearButtons(receipt: import('../chat/provider.ts').ChatReceipt, signal?: AbortSignal) { await this.call('clearButtons', chatReceiptSchema.parse(receipt), signal); }
  async acknowledge(eventId: string, text: string, signal?: AbortSignal) { await this.call('acknowledge', { eventId, text }, signal); }
  async isMember(chatId: string, userId: string, signal?: AbortSignal) { return z.boolean().optional().parse(await this.call('isMember', { chatId, userId }, signal)); }
  guarded(valid: () => boolean): ChatTransport { return new ChatExtensionBridge(this.invoke, this.generation, () => this.valid() && valid()); }
  connect(_journal: ReceiveJournal, options: ChatConnectionOptions): ChatConnection {
    let state: import('../chat/connection.ts').ChatHealth = { state: 'stopped' };
    const bridge = this;
    return { start: () => { void bridge.call('start', {}, undefined).then(() => { state = { state: 'polling' }; options.onHealth(state); }).catch(() => { state = { state: 'blocked' }; options.onHealth(state); }); },
      async stop() { await bridge.call('stop', {}); state = { state: 'stopped' }; options.onHealth(state); }, health: () => state };
  }
  /** Validate and forward an event emitted by the extension worker. */
  async accept(event: unknown, sink: (event: ChatEvent) => Promise<void>): Promise<void> { await sink(chatEventSchema.parse(event)); }
}
