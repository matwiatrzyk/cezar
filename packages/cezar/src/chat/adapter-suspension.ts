import { randomUUID } from 'node:crypto';
import { mkdir, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWrite, readState, statePath, syncDirectory } from '../webhooks/storage.ts';
import { inboundStateFilename, forgetReplies, type InboundStateStore } from './state.ts';

// A write-ahead checkpoint beside the inbound state: it records which receivers to restore
// before they are disabled, so an interrupted disable never loses their consent.
const suspensionSchema = z.strictObject({
  bindingGeneration: z.uuid(), before: z.uuid(), after: z.uuid(),
  receivers: z.array(z.strictObject({ receiverId: z.string().min(1).max(128), generation: z.uuid() })).max(20),
});
/** Called with the bot lease held and its receive transport drained. */
export async function setAdapterSuspension(directory: string, store: InboundStateStore, enabled: boolean, now: number): Promise<void> {
  store.assertReady();
  const path = statePath(directory, 'adapter-selection');
  const before = store.snapshot(), name = inboundStateFilename(before.botId);
  let saved = await readState(path, name, suspensionSchema, 16 * 1024);
  if (!enabled) {
    if (saved?.bindingGeneration === before.binding.generation && saved.after === before.configGeneration) return;
    const receivers = before.receivers.filter(row => row.enabled).map(({ receiverId, generation }) => ({ receiverId, generation }));
    if (!receivers.length) return;
    saved = { bindingGeneration: before.binding.generation, before: before.configGeneration, after: randomUUID(), receivers };
    await mkdir(path, { recursive: true, mode: 0o700 });
    store.assertReady();
    // Write ahead: an interruption here leaves the original consent intact.
    await atomicWrite(path, name, saved);
    const checkpoint = saved;
    await store.change(state => {
      if (state.configGeneration !== checkpoint.before || state.binding.generation !== checkpoint.bindingGeneration) throw Error('Chat configuration changed during adapter disable');
      for (const row of state.receivers) row.enabled = false;
      forgetReplies(state, () => true);
      state.configGeneration = checkpoint.after;
    });
    return;
  }
  if (!saved) return;
  const checkpoint = saved;
  if (before.binding.generation === checkpoint.bindingGeneration && before.configGeneration === checkpoint.after) {
    await store.change(state => {
      if (state.binding.generation !== checkpoint.bindingGeneration || state.configGeneration !== checkpoint.after) throw Error('Chat configuration changed during adapter enable');
      for (const row of state.receivers) {
        if (!checkpoint.receivers.some(prior => prior.receiverId === row.receiverId && prior.generation === row.generation)) continue;
        row.enabled = true; row.generation = randomUUID(); row.acceptAfter = now;
        for (const grant of state.grants) if (grant.receiverId === row.receiverId) grant.enableGeneration = row.generation;
      }
      state.configGeneration = randomUUID();
    });
  }
  // A newer user decision owns the state. Never restore over it.
  store.assertReady();
  await unlink(statePath(path, name)); await syncDirectory(path);
}
