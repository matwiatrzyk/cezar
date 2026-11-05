import { describe, expect, it, vi } from 'vitest';
import { ChatExtensionBridge } from './chat-bridge.ts';
import { ChatTransportError } from '../chat/provider.ts';

const identity = { id: 'bot-1', username: 'test-bot' };
const receipt = { chatId: 'room-1', messageId: 'message-1' };

describe('chat extension bridge', () => {
  it('serializes the public operations and preserves opaque receipts', async () => {
    const invoke = vi.fn(async (request: { operation: string; generation: string; input: unknown }) => {
      if (request.operation === 'identify') return identity;
      if (request.operation === 'send') return receipt;
      return undefined;
    });
    const bridge = new ChatExtensionBridge(invoke, 'generation-1');
    await expect(bridge.identify()).resolves.toEqual(identity);
    await expect(bridge.send('room-1', { text: 'hello' })).resolves.toEqual(receipt);
    expect(invoke).toHaveBeenNthCalledWith(1, { operation: 'identify', generation: 'generation-1', input: {} }, undefined);
    expect(invoke).toHaveBeenNthCalledWith(2, { operation: 'send', generation: 'generation-1', input: { chatId: 'room-1', message: { text: 'hello' } } }, undefined);
  });

  it('fences disabled adapters before and after an async wire call', async () => {
    let enabled = true;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const invoke = vi.fn(async () => { await pending; return receipt; });
    const bridge = new ChatExtensionBridge(invoke, 'generation-1', () => enabled);
    const send = bridge.send('room-1', { text: 'hello' });
    enabled = false;
    release();
    await expect(send).rejects.toMatchObject({ failure: { kind: 'blocked' } });
    await expect(bridge.send('room-1', { text: 'again' })).rejects.toMatchObject({ failure: { kind: 'blocked' } });
  });

  it('maps extension failures to the core transport vocabulary', async () => {
    const bridge = new ChatExtensionBridge(async () => { throw new ChatTransportError({ kind: 'rate_limited', retryAfterMs: 250 }); }, 'generation-1');
    await expect(bridge.send('room-1', { text: 'hello' })).rejects.toMatchObject({ failure: { kind: 'rate_limited', retryAfterMs: 250 } });
  });
});
