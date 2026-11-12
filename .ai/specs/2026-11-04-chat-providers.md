# Chat providers: one seam for two-way chat integrations

Status: implemented; shipped adapters later moved to public plugins (`2026-11-09-independent-chat-plugins.md`). Builds on spec 2026-10-29 (Telegram) and spec
2026-11-03 (Integrations gallery).

## Intent

Telegram is cezar's first two-way chat integration. Slack and Discord should follow without
copying `packages/cezar/src/telegram/`. This spec splits that module into a provider-agnostic
core and a thin transport, so a new chat platform is one provider implementation plus its
cockpit descriptor.

The pairing, permissions, confirmed previews, durable journal, source records and final-reply
routing are the hard, already-reviewed part. They become shared. A provider only speaks its
platform's wire protocol.

## Non-goals

- External plugins, a loader, a public SDK or a `cez plugin` command. The interface here is
  internal and may change in one commit together with every provider. Whether to publish it
  is decided after three providers use it.
- Any behaviour change for Telegram. Moving Telegram onto the seam is a refactor.
- New task actions. Commands, permissions and previews are the ones spec 2026-10-29 defines.

## Invariants

Every invariant of spec 2026-10-29 holds for every provider, enforced in the core rather than
re-implemented per provider:

- A chat command never becomes an unaudited shell or account-control channel.
- No success message is sent for an effect that was not durably claimed and authorized.
- A transient platform, vault, disk or provider failure never revokes a valid pairing.
- Nothing contacts the platform before dedicated-bot consent and an explicit activation.
- A provider never sees the run store, the vault or `ProjectContext`. It receives the
  credentials it declared and emits normalized events.

## One integration per platform, two modes

Each platform is one integration with the two modes Telegram already has: **notifications**
and **task control**. The existing one-way receivers are the notifications mode of that
integration, not a separate product:

- A `slack.v1` or `discord.v1` receiver configured with an incoming-webhook URL is that
  platform's notifications-only setup, as if someone had clicked through the wizard and
  consented to notifications only. It keeps its format and its stored shape.
- Task control needs the bot. Turning it on for an incoming-webhook receiver connects the
  bot, pairs it in that channel and adds the bot credentials and the discovered chat to the
  same receiver. From then on its notifications also go through the bot, so a reply to a
  notification can reach its task.
- A new setup may also start with the bot and notifications only, as Telegram does.

The webhook delivery path keeps sending through the incoming-webhook URL while a receiver has
no bot. A receiver with a bot sends through the provider, under the shared send budget.

**Downgrade:** 0.17.x and 0.18.x read `endpoints.json` strictly. Bot fields are written only on
a receiver that has a bot, so projects whose Slack and Discord receivers stay webhook-only remain
readable by those versions. A project with a bot-connected receiver has the same known
limitation as a Telegram receiver, and `BACKWARD_COMPATIBILITY.md` says so.

## Layers

| Layer | Owns | Today in |
| --- | --- | --- |
| Core (`src/chat/`) | inbound state store, bot binding and ownership lease, pairing, grants and authorization, action previews and the journal, the conversation router and commands, source records, outcome observation and final replies, setup orchestration, the send-budget scheduler | `state`, `bindings`, `ownership`, `recovery`, `pairing`, `authorization`, `actions`, `conversation`, `message-router`, `controls`, `task-target`, `runtime`, `setup`, `send-budget`, `service` |
| Provider (`src/chat/providers/<id>/`) | credential check and bot identity, receiving events, sending and editing messages, buttons, membership checks, rendering and length limits, error classification | `client`, `protocol`, `poller`, `group-events`, `private-text`, and the renderers in `webhooks/telegram.ts` |
| Outbound delivery | queue, retries, history, privacy profiles, Pause/Resume for notifications | `webhooks/` (unchanged; a chat receiver stays a receiver there) |

The split above is a starting map. A file that mixes both halves, like `runtime.ts` and
`conversation.ts`, is split by what it decides, not where it lives.

## The provider interface

In-tree only. Shapes are zod schemas in the core, types inferred, like every other boundary.

```ts
interface ChatProvider {
  id: 'telegram' | 'slack' | 'discord';
  /** Secrets the core stores in the project SecretStore; the provider gets them back, nothing else. */
  credentials: readonly { name: string; label: string; pattern?: RegExp }[];
  limits: {
    maxText: number;              // measured after rendering
    markup: 'html' | 'mrkdwn' | 'markdown';
    buttonsPerMessage: number;
    perChatPerSecond: number;     // feeds the shared send budget
    perBotPerSecond: number;
  };
  /** getMe-style check; also returns the stable bot id the ownership lease is keyed by. */
  identify(credentials, signal): Promise<{ botId: string; username: string }>;
  /** Long-lived receive loop: long polling, Socket Mode or a gateway. Resolves on stop. */
  connect(credentials, sink: ChatEventSink, signal): Promise<void>;
  send(chat: ChatRef, message: ChatMessage): Promise<ChatReceipt>;
  clearButtons(receipt: ChatReceipt): Promise<void>;
  acknowledge(event: ButtonEvent, text?: string): Promise<void>;
  isMember?(chat: ChatRef, userId: string): Promise<boolean | undefined>;
  render(message: CoreMessage): ChatMessage;   // escaping and the length budget live here
}
```

Normalized events the sink accepts:

- **message**: chat (id, `private` or `group`), user id, message id, date, text, whether the
  bot was addressed, and the receipt it replies to, if any. Telegram's reply-to, Slack's
  `thread_ts` and Discord's message reference all map to that receipt.
- **button**: chat, user, message receipt, opaque callback data.
- **membership**: the bot was removed from a chat, or a group moved to a new id.
- **start**: the discovery signal setup waits for (Telegram `/start`, a Slack or Discord
  mention or DM).

Errors are classified once, by the provider, into `auth`, `conflict`, `rate_limited`
(with `retryAfterMs`), `gone` and `transient`. The core maps them to the existing health states
(`credentials-unavailable`, `conflict`, `backoff`, `blocked`). No platform status code reaches
the core.

Commands stay text. The core parses `/status 1a2b` from message text. A provider that has native
commands (Slack slash commands, Discord application commands) may translate them into the same
text form, but nothing requires them.

## Group routing

In a group, a message reaches a task when it is either:

- a **reply to a bot message**: Telegram reply-to, a Slack thread reply or a Discord message
  reference to a bot message. No mention is needed, because the platform ties the reply to the
  message and the message to its task;
- or an **addressed command**: `/command@bot` in Telegram, a mention of the bot in Slack and
  Discord.

Any other group message is ignored. Grants, freshness and confirmed previews apply unchanged,
and new tasks still start only from a private chat.

## Stored state and records

- **Run record:** `telegramSource` becomes `chatSource`, with a `provider` field and string ids
  validated by the provider's id schema. The public projection (`public-run.ts`) keeps hiding
  chat, user and bot ids.
- **Inbound state:** `~/.cezar/telegram/bots/<botId>/` becomes `~/.cezar/chat/<provider>/bots/<botId>/`.
  The state schema gains `provider`; its ids are strings checked by that provider's schema.
- **Receivers:** `telegramChatId` and `telegramSecret` become `chatId` and `chatSecret`, shared
  by every provider's bot-connected receivers.

These are plain renames, with no read-both parsing and no migration. Telegram, the gallery and
this whole stack are released together, so no released version ever wrote the old names. That
holds only while no release is cut from the middle of the stack. If one is, the renames that
release carries need read-both parsing and a `BACKWARD_COMPATIBILITY.md` entry instead.

## HTTP API

One chained route-family builder, mounted once per provider at `/api/v1/<provider>/…` and its
project alias. Telegram's paths stay exactly as they are; Slack gets `/api/v1/slack/…`. The
contract defines each shape once with the provider as a parameter, and keeps the existing
`Telegram*` type names as aliases. `contract-parity` and `route-parity` run per provider.

## Cockpit

- The wizard keeps its steps: check credentials, discover the chat, choose people and
  permissions, activate. A provider descriptor supplies the label, icon, credential fields,
  the discovery hint ("send `/start` to your bot", "mention the app in a channel") and its own
  help links.
- Each descriptor contributes its gallery tile, which is the provider registry the gallery
  spec names as its follow-up. The Slack and Discord tiles list webhook-only and
  bot-connected receivers together, and offer **Add task control** on a webhook-only one.

## Platforms

Every transport needs no public URL, so cezar stays local and zero-config. The `ws` package is
already a dependency; no platform SDK is added.

| Platform | Receive | Credentials | Notes |
| --- | --- | --- | --- |
| Telegram | `getUpdates` long polling | bot token | unchanged |
| Slack | Socket Mode WebSocket | app-level token (`xapp-…`) and bot token (`xoxb-…`) | each envelope is acknowledged within 3 s; replies use threads |
| Discord | Gateway WebSocket | bot token | heartbeat and resume; reading group text needs the Message Content intent enabled in the developer portal |

## Rollout

One stack, released together, on top of specs 2026-10-29 (Telegram) and 2026-11-03 (gallery):

1. **Extract the core and move Telegram onto it**, with the renames above. No behaviour change.
   The existing Telegram suites pass with only their imports and names changed, and the two
   Telegram e2e suites pass.
2. **Provider descriptors in the cockpit** and the gallery registry.
3. **Slack provider**, including **Add task control** on webhook-only receivers, with its own
   short spec for platform details.
4. **Discord provider**, likewise.

## Verification

A conformance suite in the core runs every provider against a simulated platform: pairing,
a question answered with a button, `/task` with Confirm, the final reply in the same chat,
a reply in a group thread without a mention, a credential rotation, a rate limit, removal
from a group. A provider is done when it passes that suite unchanged. A webhook-only receiver
upgraded to task control is covered by the Slack and Discord suites. The same suite would be
the basis of any later plugin test kit.

Stage A implementation decisions and the provider file map are recorded in
`docs/adding-chat-provider.md`. Rollout steps 2–4 are implemented: Slack (Socket Mode) and
Discord (Gateway) bot transports are registered beside Telegram, with their platform details in
`2026-11-04-slack-chat.md` and `2026-11-04-discord-chat.md`.
