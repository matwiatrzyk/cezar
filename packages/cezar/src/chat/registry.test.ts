import { describe, expect, it } from 'vitest';
import { registerChatExtension, chatProvider } from './registry.ts';

describe('chat provider registry', () => {
  it('registers and removes an extension provider without changing built-ins', () => {
    const descriptor = { id: 'acme/relay' as const, label: 'Relay', format: 'acme/relay.v1', credentials: [], ids: { bot: {} as never, chat: {} as never, user: {} as never, message: {} as never }, presentation: {} as never, limits: { maxText: 100, buttonsPerMessage: 1, perChatPerSecond: 1, perBotPerSecond: 1 }, destination: (value: string) => value, credentialBotId: () => undefined };
    const dispose = registerChatExtension(descriptor, () => ({}) as never);
    expect(chatProvider('telegram')?.format).toBe('telegram.v1');
    expect(chatProvider('acme/relay')?.label).toBe('Relay');
    dispose();
    expect(chatProvider('acme/relay')).toBeUndefined();
  });
  it('rejects duplicate extension IDs', () => {
    const descriptor = { id: 'acme/duplicate' as const, label: 'Duplicate', format: 'acme/duplicate.v1', credentials: [], ids: { bot: {} as never, chat: {} as never, user: {} as never, message: {} as never }, presentation: {} as never, limits: { maxText: 100, buttonsPerMessage: 1, perChatPerSecond: 1, perBotPerSecond: 1 }, destination: (value: string) => value, credentialBotId: () => undefined };
    const dispose = registerChatExtension(descriptor, () => ({}) as never);
    expect(() => registerChatExtension(descriptor, () => ({}) as never)).toThrow('already registered');
    dispose();
  });
});
