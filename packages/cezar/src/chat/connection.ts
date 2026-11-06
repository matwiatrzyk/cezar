import type { InputUpdate } from './events.ts';
/** Health values retain HTTP compatibility; `polling` means receiving on any transport. */
export type ChatHealth = { state: 'stopped' | 'polling' | 'backoff' | 'conflict' | 'credentials-unavailable' | 'blocked'; lastSuccessfulPollAt?: number };
export interface ChatConnection { start(): void; stop(): Promise<void>; health(): ChatHealth }
export interface ChatConnectionOptions {
  accept(event: import('./provider.ts').ChatEvent): Promise<void>;
  process(update: InputUpdate, epoch: string): Promise<void>;
  needed(): boolean;
  assertCredentials(): Promise<void>;
  onHealth(health: ChatHealth): void;
  /** Optional provider-native command hooks. Providers must map execution back into ChatEvent semantics. */
  nativeCommands?: {
    tasks(query: string, chatId: string, userId: string): Promise<readonly { name: string; value: string }[]>;
  };
}
export type ChatConnect = (options: ChatConnectionOptions) => ChatConnection;
/** The receive adapter can checkpoint and deduplicate, but cannot inspect grants, sources or runs. */
export interface ReceiveJournal {
 recover(): Promise<void>; assertReady(): void; prepareReceive(now: number, idleResetMs?: number): Promise<void>;
 snapshot(): { epoch: string; nextOffset: number | null };
 duplicate(epoch: string, sequence: number): boolean;
 finish(epoch: string, sequence: number): Promise<void>;
 touch(at: number): Promise<void>; flush(): Promise<void>;
}
