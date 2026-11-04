import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { ChatInbox } from './inbox.ts';
import { chatEventSchema, type ChatEvent } from './provider.ts';
import { freshState, InboundStateStore } from './state.ts';
const event = (id = 'socket-envelope:a'): ChatEvent => ({ kind: 'message', id, chat: { id: 'CHANNEL_A', kind: 'group' }, user: { id: 'USER_A', label: 'A' }, messageId: 'thread:123.456', at: 1000, text: 'answer', addressed: false, replyTo: { chatId: 'CHANNEL_A', messageId: 'thread:123.000' } });
const initial = () => freshState('BOT_A', { projectId: 'p', installationId: 'i', root: '/project', generation: randomUUID() }, 'slack');
describe('non-polling event journal', () => {
 it('claims opaque events before processing and serializes simultaneous duplicates', async () => {
  let disk = initial();
  const state = new InboundStateStore(disk, { assertOwner() {}, write: async value => { disk = structuredClone(value); } });
  const process = vi.fn(async update => { expect(disk.receivedEvents.at(-1)?.sequence).toBe(update.sequence); });
  const inbox = new ChatInbox(state, process);
  await Promise.all([inbox.accept(event()), inbox.accept(event()), inbox.accept(event('socket-envelope:b'))]);
  expect(process).toHaveBeenCalledTimes(2);
  expect(process.mock.calls.map(([update]) => update.sequence)).toEqual([0, 1]);
  expect(process.mock.calls[0]![0].message).toMatchObject({ id: 'thread:123.456', replyTo: 'thread:123.000' });
 });
 it('never replays an uncertain claimed event after a crash or restart', async () => {
  let disk = initial();
  const state = new InboundStateStore(disk, { assertOwner() {}, write: async value => { disk = structuredClone(value); } });
  await expect(new ChatInbox(state, async () => { throw new Error('crash'); }).accept(event())).rejects.toThrow('crash');
  const recovered = new InboundStateStore(disk, { assertOwner() {}, write: async () => {} });
  await recovered.recover();
  const process = vi.fn();
  await new ChatInbox(recovered, process).accept(event());
  expect(process).not.toHaveBeenCalled();
 });
 it('never processes an event whose claim could not be persisted', async () => {
  const state = new InboundStateStore(initial(), { assertOwner() {}, write: async () => { throw new Error('disk unavailable'); } });
  const process = vi.fn();
  await expect(new ChatInbox(state, process).accept(event())).rejects.toThrow();
  expect(process).not.toHaveBeenCalled();
 });
 it('rejects cross-chat message and button receipts before they enter authorization', () => {
  expect(chatEventSchema.safeParse({ ...event(), replyTo: { chatId: 'OTHER', messageId: 'thread:1' } }).success).toBe(false);
  expect(chatEventSchema.safeParse({ kind: 'button', id: 'button:1', chat: { id: 'CHANNEL_A', kind: 'group' }, user: { id: 'USER_A', label: 'A' }, receipt: { chatId: 'OTHER', messageId: 'thread:1' }, data: 'opaque' }).success).toBe(false);
 });
});
