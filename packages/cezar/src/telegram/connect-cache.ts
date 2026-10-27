import type { TelegramChat, TelegramConnectResponse } from '@open-mercato/cezar-contract';
import type { TelegramMessage } from './protocol.ts';
interface Session { until: number; match?: TelegramChat }
/** Connect codes are configuration discovery only; they never become grants or agent commands. */
export class ConnectCache {
  private sessions = new Map<string, Session>();
  constructor(private readonly bot: TelegramConnectResponse['bot'], private readonly now: () => number = Date.now) {}
  private prune(): void { for (const [code, session] of this.sessions) if (session.until <= this.now()) this.sessions.delete(code); }
  read(code: string): TelegramConnectResponse {
    this.prune();
    if (!/^[A-Za-z0-9]{12,32}$/.test(code)) throw new Error('invalid_connect_code');
    let session = this.sessions.get(code);
    if (!session) {
      if (this.sessions.size >= 3) throw new Error('connect_limit');
      session = { until: this.now() + 300_000 }; this.sessions.set(code, session);
    }
    return { bot: this.bot, chats: session.match ? [structuredClone(session.match)] : [], ...(session.match ? { match: structuredClone(session.match) } : {}) };
  }
  capture(message: TelegramMessage): boolean {
    this.prune();
    if (!message.text || message.forward_origin !== undefined || message.via_bot !== undefined || message.sender_chat !== undefined || message.from?.is_bot !== false) return false;
    const match = /^\/start(?:@([A-Za-z0-9_]+))?\s+([A-Za-z0-9]{12,32})$/i.exec(message.text.trim());
    if (!match || (match[1] && match[1].toLowerCase() !== this.bot.username.toLowerCase())) return false;
    const session = this.sessions.get(match[2]!); if (!session) return false;
    const title = message.chat.type === 'private' ? [message.from.first_name, message.from.last_name].filter(Boolean).join(' ') || String(message.chat.id) : message.chat.title ?? String(message.chat.id);
    session.match = { id: String(message.chat.id), type: message.chat.type, title: title.slice(0, 256) };
    return true;
  }
}
