import { describe, expect, it } from 'vitest';
import { registerChatExtension, chatProvider } from './registry.ts';

describe('chat provider registry', async () => {
  it('registers and removes an extension provider without changing built-ins', async () => {
    const descriptor = { id: 'acme/relay' as const, label: 'Relay', format: 'acme/relay.v1', credentials: [], ids: { bot: {} as never, chat: {} as never, user: {} as never, message: {} as never }, presentation: {} as never, limits: { maxText: 100, buttonsPerMessage: 1, perChatPerSecond: 1, perBotPerSecond: 1 }, destination: (value: string) => value, credentialBotId: () => undefined };
    const dispose = await registerChatExtension('/project-a', descriptor, () => ({}) as never);
    expect(chatProvider('telegram')?.format).toBe('telegram.v1');
    expect(chatProvider('acme/relay', '/project-a')?.label).toBe('Relay');
    await dispose();
    expect(chatProvider('acme/relay', '/project-a')).toBeUndefined();
  });
  it('rejects duplicate extension IDs', async () => {
    const descriptor = { id: 'acme/duplicate' as const, label: 'Duplicate', format: 'acme/duplicate.v1', credentials: [], ids: { bot: {} as never, chat: {} as never, user: {} as never, message: {} as never }, presentation: {} as never, limits: { maxText: 100, buttonsPerMessage: 1, perChatPerSecond: 1, perBotPerSecond: 1 }, destination: (value: string) => value, credentialBotId: () => undefined };
    const dispose = await registerChatExtension('/project-a', descriptor, () => ({}) as never);
    await expect(registerChatExtension('/project-a', descriptor, () => ({}) as never)).rejects.toThrow('already registered');
    await dispose();
  });
});
