import { describe, expect, it, vi } from 'vitest';
import { ChatExtensionBridge, receiveRetryDelay } from './chat-bridge.ts';
import { ChatTransportError } from '../chat/provider.ts';

const identity = { id: 'bot-1', username: 'test-bot' };
const receipt = { chatId: 'room-1', messageId: 'message-1' };

describe('chat extension bridge', () => {
  it('preserves pairingEligible while mapping a public SDK message into the core', async () => {
    let cursor: number | null = null
    const accept = vi.fn(async () => {})
    const event = { kind: 'message', id: 'event-1', messageId: 'message-1', chat: { id: 'room-1', kind: 'private' as const },
      user: { id: 'person-1', label: 'Person' }, at: 1, text: '/start code', addressed: true, pairingEligible: false }
    const bridge = new ChatExtensionBridge(async () => [{ sequence: 1, event }], () => true)
    const connection = bridge.connect({ recover: async () => {}, assertReady() {}, prepareReceive: async () => {}, snapshot: () => ({ epoch: 'fixture', nextOffset: null }),
      duplicate: () => false, finish: async () => {}, touch: async () => {}, flush: async () => {}, extensionCursor: () => cursor,
      checkpointExtension: async sequence => { cursor = sequence } },
    { accept, process: async () => {}, needed: () => true, assertCredentials: async () => {}, onHealth: () => {} })
    try { connection.start(); await expect.poll(() => cursor).toBe(1) } finally { await connection.stop() }
    expect(accept).toHaveBeenCalledWith(expect.objectContaining({ pairingEligible: false }))
  })
  it('serializes the public operations and preserves opaque receipts', async () => {
    const invoke = vi.fn(async (operation: string, _input: unknown) => {
      if (operation === 'identify') return identity;
      if (operation === 'send') return receipt;
      return undefined;
    });
    const bridge = new ChatExtensionBridge(invoke, () => true);
    await expect(bridge.identify()).resolves.toEqual(identity);
    await expect(bridge.send('room-1', { text: 'hello' })).resolves.toEqual(receipt);
    expect(invoke).toHaveBeenNthCalledWith(1, 'identify', {}, expect.objectContaining({valid:expect.any(Function)}));
    expect(invoke).toHaveBeenNthCalledWith(2, 'send', { chatId: 'room-1', message: { text: 'hello' } }, expect.objectContaining({valid:expect.any(Function)}));
  });

  it('fences disabled adapters before and after an async wire call', async () => {
    let enabled = true;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const invoke = vi.fn(async () => { await pending; return receipt; });
    const bridge = new ChatExtensionBridge(invoke, () => enabled);
    const send = bridge.send('room-1', { text: 'hello' });
    enabled = false;
    release();
    await expect(send).rejects.toMatchObject({ failure: { kind: 'blocked' } });
    await expect(bridge.send('room-1', { text: 'again' })).rejects.toMatchObject({ failure: { kind: 'blocked' } });
  });

  it('maps extension failures to the core transport vocabulary', async () => {
    const bridge = new ChatExtensionBridge(async () => { throw new ChatTransportError({ kind: 'rate_limited', retryAfterMs: 250 }); }, () => true);
    await expect(bridge.send('room-1', { text: 'hello' })).rejects.toMatchObject({ failure: { kind: 'rate_limited', retryAfterMs: 250 } });
  });
});

it('backs off receive failures and checkpoints only after durable acceptance', async () => {
  let cursor: number | null = null, calls = 0
  let accept!: () => void
  const accepted = new Promise<void>(resolve => { accept = resolve })
  const event = { kind: 'message', id: 'event-1', messageId: 'message-1', chat: { id: 'room-1', kind: 'private' }, user: { id: 'person-1', label: 'Person' }, at: Date.now(), text: '/tasks', addressed: true }
  const bridge = new ChatExtensionBridge(async () => {
    if (++calls === 1) throw new ChatTransportError({ kind: 'transient' })
    return [{ sequence: 10, event }]
  }, () => true)
  const checkpoint = vi.fn(async (sequence: number) => { cursor = sequence })
  const onHealth = vi.fn()
  const connection = bridge.connect({
    recover: async () => {}, assertReady() {}, prepareReceive: async () => {}, snapshot: () => ({ epoch: 'fixture', nextOffset: null }),
    duplicate: () => false, finish: async () => {}, touch: async () => {}, flush: async () => {},
    extensionCursor: () => cursor, checkpointExtension: checkpoint,
  }, { accept: async () => accepted, process: async () => {}, needed: () => true, assertCredentials: async () => {}, onHealth })
  try {
    connection.start()
    await expect.poll(() => calls).toBe(2)
    expect(onHealth).toHaveBeenCalledWith({ state: 'backoff' })
    expect(checkpoint).not.toHaveBeenCalled()
    accept()
    await expect.poll(() => cursor).toBe(10)
  } finally { accept(); await connection.stop() }
  expect(connection.health().state).toBe('stopped')
})

it('checkpoints an eventless receive row without inventing a core event', async () => {
  let cursor: number | null = null
  const accept = vi.fn(async () => {})
  const bridge = new ChatExtensionBridge(async () => [{ sequence: 41 }], () => true)
  const connection = bridge.connect({
    recover: async () => {}, assertReady() {}, prepareReceive: async () => {}, snapshot: () => ({ epoch: 'fixture', nextOffset: null }),
    duplicate: () => false, finish: async () => {}, touch: async () => {}, flush: async () => {},
    extensionCursor: () => cursor, checkpointExtension: async sequence => { cursor = sequence },
  }, { accept, process: async () => {}, needed: () => true, assertCredentials: async () => {}, onHealth: () => {} })
  try {
    connection.start()
    await expect.poll(() => cursor).toBe(41)
  } finally { await connection.stop() }
  expect(accept).not.toHaveBeenCalled()
})

it('backs off a persistently failing receive exponentially, capped at a minute (M3)', async () => {
  vi.useFakeTimers()
  const at: number[] = []
  const bridge = new ChatExtensionBridge(async () => { at.push(Date.now()); throw new ChatTransportError({ kind: 'transient' }) }, () => true)
  const connection = bridge.connect({
    recover: async () => {}, assertReady() {}, prepareReceive: async () => {}, snapshot: () => ({ epoch: 'fixture', nextOffset: null }),
    duplicate: () => false, finish: async () => {}, touch: async () => {}, flush: async () => {},
    extensionCursor: () => null, checkpointExtension: async () => {},
  }, { accept: async () => {}, process: async () => {}, needed: () => true, assertCredentials: async () => {}, onHealth: () => {} })
  try {
    connection.start()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    const gaps = at.slice(1).map((time, index) => time - at[index]!)
    expect(gaps.slice(0, 7)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000])
    expect(Math.max(...gaps)).toBe(60000)
  } finally { await connection.stop(); vi.useRealTimers() }
})

it('keeps a rate limit at its requested wait', () => {
  expect(receiveRetryDelay({ kind: 'rate_limited', retryAfterMs: 5000 }, 9)).toBe(5000)
  expect(receiveRetryDelay({ kind: 'transient' }, 30)).toBe(60000)
})
