import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { freshState, InboundStateStore } from './state.ts';
import { processGroupEvent } from './group-events.ts';
it.each(['migration', 'removal'] as const)('%s suspends only the affected group and persists the update offset in the same write', async kind => {
  const initial = freshState('123', { projectId: 'project', root: '/repo', installationId: 'install', generation: randomUUID() });
  for (const chatId of ['-123', '-456']) initial.receivers.push({ receiverId: chatId, chatId, enabled: true, generation: randomUUID(), deliveryRevision: 1, credentialFingerprint: 'a'.repeat(64), acceptAfter: 0 });
  let writes = 0;
  const state = new InboundStateStore(initial, { assertOwner() {}, async write() { writes++; } });
  const update = kind === 'migration' ? { update_id: 5, message: { message_id: 1, date: 10, chat: { id: -123, type: 'group' as const }, migrate_to_chat_id: -100123 } }
    : { update_id: 5, my_chat_member: { chat: { id: -123, type: 'group' as const }, new_chat_member: { status: 'left' } } };
  expect(await processGroupEvent(state, update, initial.epoch)).toBe(true);
  expect(state.snapshot().receivers[0]).toMatchObject({ enabled: false, chatId: '-123' });
  expect(state.snapshot().receivers[0]!.generation).not.toBe(initial.receivers[0]!.generation);
  expect(state.snapshot().receivers[1]).toEqual(initial.receivers[1]);
  expect(state.snapshot().nextOffset).toBe(6); expect(writes).toBe(1);
});
