type AuxiliaryMethod = 'answerCallbackQuery' | 'editMessageReplyMarkup';
export interface SendReservation { sent(): void; release(): void }
interface Ticket {
  id: string; chat: string; readyAt: number; expiresAt: number; valid(): boolean;
}
/** Controller-owned admission only: payloads stay in the reply queue or durable outbox. */
export class TelegramSendBudget {
  private tickets = new Map<string, Ticket>();
  private chats: string[] = [];
  private chatNext = new Map<string, number>();
  private botNext = 0;
  private reserved?: symbol;
  private methodNext = new Map<AuxiliaryMethod, number>();
  constructor(private readonly now: () => number = Date.now) {}
  private valid(ticket: Ticket): boolean {
    try { return ticket.expiresAt > this.now() && ticket.valid(); } catch { return false; }
  }
  private prune(): void {
    for (const [id, ticket] of this.tickets) if (!this.valid(ticket)) this.tickets.delete(id);
    const live = new Set([...this.tickets.values()].map(ticket => ticket.chat));
    this.chats = this.chats.filter(chat => live.has(chat));
    for (const [chat, until] of this.chatNext) if (until <= this.now()) this.chatNext.delete(chat);
  }
  offer(ticket: Ticket, firstInChat = false): boolean {
    this.prune();
    if (!this.valid(ticket)) { this.cancel(ticket.id); return false; }
    const previous = this.tickets.get(ticket.id);
    if (previous && previous.chat !== ticket.chat) this.cancel(ticket.id);
    if (!this.tickets.has(ticket.id) && this.tickets.size >= 200) {
      // Keep room for ephemeral command replies even when a durable
      // notification backlog fills the shared ticket cap.
      const reply = ticket.id === 'reply' || ticket.id.startsWith('reply:');
      if (!reply) return false;
      const evict = [...this.tickets.keys()].find(id => id !== 'reply' && !id.startsWith('reply:'));
      if (!evict) return false;
      this.tickets.delete(evict);
    }
    if (firstInChat) { this.tickets.delete(ticket.id); this.tickets = new Map([[ticket.id, ticket], ...this.tickets]); }
    else this.tickets.set(ticket.id, ticket);
    if (!this.chats.includes(ticket.chat)) this.chats.push(ticket.chat);
    return true;
  }
  cancel(id: string): void { this.tickets.delete(id); this.prune(); }
  cooldown(until: number): void { if (Number.isFinite(until)) this.botNext = Math.max(this.botNext, until); }
  winner(): string | undefined {
    this.prune(); const now = this.now();
    if (this.reserved || this.botNext > now) return;
    for (const chat of this.chats) {
      if ((this.chatNext.get(chat) ?? 0) > now) continue;
      // A delayed notification or retry must not hide a ready reply in the
      // same chat. Preserve insertion order among tickets that are ready.
      const ready = [...this.tickets.values()].find(ticket => ticket.chat === chat && ticket.readyAt <= now);
      if (ready) return ready.id;
    }
    return undefined;
  }
  methodReady(method: AuxiliaryMethod): boolean { return (this.methodNext.get(method) ?? 0) <= this.now(); }
  cooldownMethod(method: AuxiliaryMethod, until: number): void {
    if (Number.isFinite(until)) this.methodNext.set(method, Math.max(this.methodNext.get(method) ?? 0, until));
  }
  /** Reserve only for an already-ready durable claim, never for a timer or scheduler wait. */
  reserve(id: string): SendReservation | undefined {
    if (this.winner() !== id) return;
    const ticket = this.tickets.get(id)!, token = Symbol(); this.reserved = token; let sent = false;
    return {
      release: () => { if (this.reserved === token) this.reserved = undefined; },
      sent: () => {
        if (this.reserved !== token || sent) return;
        sent = true; this.tickets.delete(id);
        this.chats = this.chats.filter(chat => chat !== ticket.chat);
        if ([...this.tickets.values()].some(row => row.chat === ticket.chat)) this.chats.push(ticket.chat);
        this.botNext = Math.max(this.botNext, this.now() + 100);
        this.chatNext.set(ticket.chat, this.now() + 1000);
      },
    };
  }
  take(id: string): boolean {
    const reservation = this.reserve(id); if (!reservation) return false;
    reservation.sent(); reservation.release(); return true;
  }
  /** Return the earliest time at which this budget can change its winner. */
  nextCheck(): number {
    this.prune();
    const now = this.now();
    const deadlines: number[] = [];
    for (const ticket of this.tickets.values()) {
      const chatReady = this.chatNext.get(ticket.chat) ?? 0;
      deadlines.push(Math.max(now + 100, this.botNext, chatReady, ticket.readyAt));
    }
    return deadlines.length ? Math.min(...deadlines) : Math.max(now + 100, this.botNext);
  }
}
