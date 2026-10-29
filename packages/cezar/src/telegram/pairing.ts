import { createHash, randomBytes, randomUUID, randomInt } from 'node:crypto';
import type { TelegramMessage } from './protocol.ts';
import { eligibleText, freshMessage, parseCommand } from './protocol.ts';

export interface PairingSession {
  id: string; receiverId: string; botId: string; chatId: string; deliveryRevision: number;
  createdAt: number; expiresAt: number; hash: string; candidate?: { userId: string; label: string; username?: string; comparisonCode?: string };
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class Pairings {
  private readonly sessions = new Map<string, PairingSession>();
  /** Keep expired ids briefly so the HTTP status can distinguish expiry from an unknown id. */
  private readonly expired = new Map<string, PairingSession>();
  constructor(private readonly now: () => number = Date.now) {}
  prune(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) {
      this.sessions.delete(id); this.expired.set(id, session);
    }
    for (const [id, session] of this.expired) if (session.expiresAt + 300_000 <= now) this.expired.delete(id);
  }
  create(input: Pick<PairingSession, 'receiverId' | 'botId' | 'chatId' | 'deliveryRevision'>, username: string): { session: PairingSession; deepLink: string } {
    this.prune();
    if (this.sessions.size >= 3) throw new Error('pairing_limit');
    if (!/^[A-Za-z0-9_]{1,64}$/.test(username)) throw new Error('invalid_bot_username');
    const code = randomBytes(24).toString('base64url');
    const session: PairingSession = { ...input, id: randomUUID(), createdAt: this.now(), expiresAt: this.now() + 300_000, hash: hash(code) };
    this.expired.delete(session.id); this.sessions.set(session.id, session);
    return { session: structuredClone(session), deepLink: `https://t.me/${username}?start=${code}` };
  }
  get(id: string): PairingSession | undefined { this.prune(); const session = this.sessions.get(id); return session ? structuredClone(session) : undefined; }
  hasBot(botId: string): boolean { this.prune(); return [...this.sessions.values()].some(session => session.botId === botId); }
  hasReceiver(receiverId: string): boolean { this.prune(); return [...this.sessions.values()].some(session => session.receiverId === receiverId); }
  cancel(id: string): void { this.sessions.delete(id); this.expired.delete(id); }
  cancelReceiver(receiverId: string): void { for (const session of this.sessions.values()) if (session.receiverId === receiverId) this.sessions.delete(session.id); }
  wasExpired(id: string): PairingSession | undefined { this.prune(); const session = this.expired.get(id); return session ? structuredClone(session) : undefined; }
  comparisonCode(botId: string, username: string, message: TelegramMessage): string | undefined {
    const command = parseCommand(message, username);
    if (command.kind !== 'command' || command.name !== 'start') return undefined;
    this.prune();
    return [...this.sessions.values()].find(session => session.botId === botId && session.hash === hash(command.args)
      && session.candidate?.userId === String(message.from?.id))?.candidate?.comparisonCode;
  }
  accept(botId: string, username: string, message: TelegramMessage): 'candidate' | 'wrong_chat' | 'ignored' {
    this.prune();
    if (!eligibleText(message)) return 'ignored';
    const command = parseCommand(message, username);
    if (command.kind !== 'command' || command.name !== 'start' || !/^[A-Za-z0-9_-]{32}$/.test(command.args)) return 'ignored';
    const digest = hash(command.args);
    const session = [...this.sessions.values()].find(session => session.botId === botId && session.hash === digest);
    if (!session || !freshMessage(message.date, session.createdAt, this.now())) return 'ignored';
    const user = message.from!;
    if (message.chat.type !== 'private' || message.chat.id !== user.id) return 'ignored';
    if (!session.chatId.startsWith('-') && String(user.id) !== session.chatId) return 'wrong_chat';
    if (session.candidate && session.candidate.userId !== String(user.id)) return 'ignored';
    session.candidate = { userId: String(user.id), label: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 256),
      ...(user.username ? { username: user.username } : {}),
      ...(session.chatId.startsWith('-') ? { comparisonCode: session.candidate?.comparisonCode ?? String(randomInt(0, 1000000)).padStart(6, '0') } : {}) };
    return 'candidate';
  }
}
