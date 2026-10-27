import { describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { BotLease, botDirectory, unboundBotRead } from './ownership.ts';

const identity = { projectId: 'project', installationId: 'instance', root: '/repo' };
const botId = () => String(randomInt(1_000_000, 999_999_999));
describe('Telegram bot ownership', () => {
  it('keeps a binding after release and refuses a second project or legacy Connect', async () => {
    const id = botId(), first = await BotLease.acquire(id);
    const binding = await first.bind(identity);
    await first.release();
    const second = await BotLease.acquire(id);
    try {
      expect(await second.bind(identity)).toEqual(binding);
      await expect(second.bind({ ...identity, projectId: 'other' })).rejects.toThrow('binding_conflict');
    } finally { await second.release(); }
    await expect(unboundBotRead(id, false, async () => 'updates')).rejects.toThrow('binding_conflict');
  });
  it('prevents a second consumer while the first owns even an unbound bot', async () => {
    const id = botId(), lease = await BotLease.acquire(id);
    try { await expect(BotLease.acquire(id)).rejects.toThrow('owner_conflict'); }
    finally { await lease.release(); }
    expect(await unboundBotRead(id, false, async () => 'updates')).toBe('updates');
  });
  it('reassignment invalidates the old generation and dry-run does not occupy a real bot', async () => {
    const id = botId(), lease = await BotLease.acquire(id);
    const binding = await lease.bind(identity);
    const dry = await BotLease.acquire(id, true);
    await dry.release();
    expect(botDirectory(id, true)).not.toBe(botDirectory(id));
    await lease.disconnect(binding);
    const replacement = await lease.bind(identity);
    expect(replacement.generation).not.toBe(binding.generation);
    await expect(lease.validate(binding)).rejects.toThrow('binding_changed');
    await lease.release();
  });
  it('releases the short Connect lock when the provider fails', async () => {
    const id = botId();
    await expect(unboundBotRead(id, false, async () => { throw new Error('provider'); })).rejects.toThrow('provider');
    const lease = await BotLease.acquire(id); await lease.release();
  });
});
