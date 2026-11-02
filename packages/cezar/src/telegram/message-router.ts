import type { TelegramUpdate } from './protocol.ts';
import { parseCommand } from './protocol.ts';
import type { InboundState, Correlation } from './state.ts';
import type { RunRecord } from '../runs/store.ts';

/**
 * Router context: everything the classifier needs to make routing decisions.
 * Does not include authorization or freshness — those are conversation layer concerns.
 */
export interface RouterContext {
  /** Bot username for command parsing */
  botUsername: string;
  chatId: string;
  userId: string;
  receiverId: string;
  /** Current inbound state with correlations */
  state: InboundState;
  /** All runs to search for waiting tasks */
  runs: readonly RunRecord[];
  /** Episode ID lookup for each run */
  episode: (runId: string) => string | undefined;
}

/**
 * Telegram message routing variants, in precedence order:
 * 1. command: recognized slash command (handled as command, never delivered to agent)
 * 2. explicit-reply: Telegram Reply with correlation (uses message correlation)
 * 3. implicit-reply: ordinary text in approved private chat (latest pending episode)
 * 4. unhandled: everything else (shown help or rejected)
 */
export type TelegramMessageRoute =
  | { kind: 'command'; name: string; args: string }
  | { kind: 'explicit-reply'; correlation: Correlation; text: string }
  | { kind: 'implicit-reply'; runId: string; text: string }
  | { kind: 'unhandled' };

const KNOWN_COMMANDS = ['help', 'task', 'tasks', 'status', 'reply', 'cancel', 'continue'];

/**
 * Find the latest pending episode for the given chat.
 * Returns the run ID of the latest non-archived waiting task that has an episode.
 */
function findLatestPendingEpisode(
  context: RouterContext,
  runs: readonly RunRecord[],
  episode: (runId: string) => string | undefined
): string | undefined {
  const waiting = runs.filter(run => !run.archived && run.status === 'waiting' && episode(run.id) !== undefined);
  const correlated = context.state.correlations
    .filter(correlation => correlation.receiverId === context.receiverId
      && correlation.chatId === context.chatId
      && correlation.type === 'task.attention_required')
    .filter(correlation => waiting.some(run => run.id === correlation.runId && episode(run.id) === correlation.episodeId))
    .sort((left, right) => right.createdAt - left.createdAt);
  if (correlated[0]) return correlated[0].runId;

  // A source-created task may be waiting before its first question delivery is recorded.
  // Keep this fallback scoped to the same private Telegram identity and chat.
  return [...waiting].reverse()
    .find(run => run.telegramSource?.botId === context.state.botId
      && run.telegramSource.chatId === context.chatId
      && run.telegramSource.userId === context.userId)?.id;
}

/**
 * Classify an inbound Telegram message into a routing decision.
 *
 * Precedence (from highest to lowest):
 * 1. Recognized commands (never delivered to tasks)
 * 2. Explicit Telegram Reply with correlation
 * 3. Implicit private-chat answer to latest pending episode
 * 4. Unhandled (help or rejection)
 *
 * Groups never get implicit answers; they require explicit commands or Reply.
 */
export function classifyTelegramMessage(
  update: TelegramUpdate,
  context: RouterContext
): TelegramMessageRoute {
  const message = update.message;
  if (!message?.text) {
    return { kind: 'unhandled' };
  }

  const chatId = String(message.chat.id);
  const isPrivate = message.chat.type === 'private';
  const text = message.text;

  // 1. Command precedence: recognized commands are ALWAYS routed as commands
  const command = parseCommand(message, context.botUsername);
  if (command.kind === 'command' && KNOWN_COMMANDS.includes(command.name)) {
    return { kind: 'command', name: command.name, args: command.args };
  }

  // 2. Explicit Reply precedence: Telegram Reply with valid correlation
  if (message.reply_to_message) {
    const replyToId = message.reply_to_message.message_id;
    const correlation = context.state.correlations.find(
      c => c.receiverId === context.receiverId && c.chatId === chatId && c.messageId === replyToId
    );
    if (correlation) {
      return { kind: 'explicit-reply', correlation, text };
    }
  }

  // 3. Implicit private-chat answer: only for private chats with pending episodes
  if (isPrivate && command.kind === 'text') {
    const latestRunId = findLatestPendingEpisode(context, context.runs, context.episode);
    if (latestRunId) {
      return { kind: 'implicit-reply', runId: latestRunId, text };
    }
  }

  // 4. Everything else is unhandled
  return { kind: 'unhandled' };
}
