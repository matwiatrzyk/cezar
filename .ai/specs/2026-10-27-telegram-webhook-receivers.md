# Telegram receivers for outbound webhooks

Provider contract extending [outbound webhooks](2026-10-12-outbound-webhooks.md), following the
[Discord](2026-10-19-discord-webhook-receivers.md) and [Slack](2026-10-19-slack-webhook-receivers.md)
receivers.

## Goal

A user creates a Telegram bot with @BotFather, adds it to a chat, group or channel, enters the
**bot token** and the **chat ID** in Settings → Webhooks, and gets readable task notifications in
that chat. There is no relay, no polling and no inbound webhook. Admission, grace, freshness,
retries, suspension, history, privacy profiles and ownership use the shared webhook pipeline.

## Out of scope

Answering a question from Telegram (inline keyboards, callback queries, `getUpdates`, `setWebhook`),
chat discovery or a chat picker, forum topics (`message_thread_id`), silent delivery
(`disable_notification`) as a setting, editing a message as the task progresses, a local Bot API
server or a custom API host, and automatic chat-ID rewriting after a group migration.

## Why the chat ID is a separate field

Slack and Discord encode the whole destination in one secret URL. Telegram needs two values:

- the **bot token** (`<bot id>:<secret>`), which is a credential, and
- the **chat ID** (`-100…`, a numeric user/group ID or `@channelusername`), which is an address, not a credential.

Putting `chat_id` in the URL query was rejected because:
1. users would have to assemble a URL by hand;
2. chat receivers with a query string are deliberately treated as unknown destinations by
   `transport.ts`, which discards their response body because a query can carry credentials, and
   that rule would need a Telegram exception;
3. it relies on Telegram merging query-string and JSON-body parameters.

A separate field keeps the token inside the existing private-URL mechanism and lets the card show
the chat without revealing anything secret.

## Design

### 1. Contract (`packages/contract/src/webhooks.ts`)

- `webhookFormatSchema` adds `'telegram.v1'`.
- `settings` gains `telegramChatId: z.string().trim().regex(/^(?:-?[0-9]{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/).optional()`.
  It is required when `format === 'telegram.v1'` and must be absent otherwise. Enforce both in
  `chatDestination` (path `['telegramChatId']`).
- **Transport stays URL-based.** The API keeps `url`, like every other format. For `telegram.v1`:
  - the URL must be exactly `https://api.telegram.org/bot<id>:<secret>/sendMessage`, with no
    port, query or fragment;
  - the bot ID must match `[0-9]{5,15}` and the secret `[A-Za-z0-9_-]{30,64}`;
  - `allowLocalNetwork === false`.

  The cockpit builds this URL from the token field (§4). API and CLI clients send the full URL,
  which keeps one credential path for all chat formats.
- `updateWebhookSchema`: an edit may change `telegramChatId` without resending `url`. The registry
  re-validates the pair after restoring the private URL (the existing "validates again" path).
- `webhookReceiverSchema` (response) gains `telegramChatId` as an optional field. Spread it
  conditionally so it is absent from the wire for other formats (AGENTS.md § HTTP API).
- An `api.telegram.org` URL submitted with `format: 'cezar.json.v1'` is rejected with "Choose
  Telegram as the destination type".
- `BACKWARD_COMPATIBILITY.md` lists `telegram.v1` among receiver formats and documents the new
  optional field.

### 2. Storage (`webhooks/endpoints.ts`)

- `telegramChatId` is stored alongside the other settings in `endpoints.json`. It is optional,
  so existing files parse unchanged and no migration is needed.
- Add `telegramChatId` to the compared field list in `update` (currently
  `['format', 'name', 'url', …]`). A change counts as a configuration change: it bumps
  `deliveryRevision` and makes the receiver inactive until re-tested. An old queued delivery
  therefore cannot land in a newly entered chat.
- `receiverSecretValues`: for `telegram.v1`, the redacted credential is the `bot<id>:<secret>` path
  segment and the bare `<id>:<secret>` token. The generic "last path segment" rule must not apply:
  for Telegram that segment is `sendMessage`, so the token would go unredacted. Pin this with a test.
- `maskDestination(url, telegramChatId)` returns `Telegram chat <chat id>` for Telegram receivers,
  in the receiver list, notices and delivery snapshots alike. The bot ID, the numeric part before
  the colon, is not secret, but leave it out anyway; the chat is what users recognise.
- `update` spreads the new settings over the old record, and a spread cannot remove a key.
  Delete `telegramChatId` explicitly when the new settings carry none, so switching a receiver
  away from Telegram does not keep a stale chat ID.

### 3. Rendering (`webhooks/telegram.ts`)

`renderTelegramMessage(eventJson: string, ctx: { receiverName?: string; chatId: string }): string`
maps the **already rendered, redacted, profile-filtered** cezar event body to a `sendMessage`
body. Telegram never receives a field that the cezar payload for that profile does not carry.

```json
{ "chat_id": "-1001234567890",
  "text": "<b>Needs your input</b> · Fix flaky login test\n\nProject: cezar\nStatus: running → waiting\nTask: <code>a1b2c3d4</code>\n\n1. Which DB?\n• Postgres — default",
  "parse_mode": "HTML",
  "link_preview_options": { "is_disabled": true } }
```

- `parse_mode: 'HTML'`. Escape `&`, `<` and `>` in every interpolated string; HTML mode needs
  nothing else. This is simpler and safer than MarkdownV2, which has 18 reserved characters.
- Bold label line, then Project / Status / Task lines. Standard profile adds the questions with
  their options (attention) or the error message (failed). Minimal adds neither.
- Link: PR, then issue, then hosted cockpit link (same precedence as Discord), as
  `<a href="…">Open</a>`, with `href` HTML-escaped and limited to `https?:`.
- Limit: `text` ≤ 4096 characters **after entity parsing**. Budget against the visible text,
  clip at a safe point that never cuts inside a tag or entity, drop trailing questions first, then
  clip, then fall back to the label line only.
- Mentions: Telegram does not resolve `@username` into a notification for bots' messages in the
  way Discord does, but neutralize `@` with a zero-width space anyway so task text cannot be read
  as a mention or a channel handle.
- `webhook.test` → "cezar is connected to this chat" + receiver name.

### 4. Send path

- Admission snapshots `format` (existing). Read `chat_id` from the receiver at claim time, together
  with `url`. The `deliveryRevision` fence (§2) guarantees that both belong to the configuration
  the delivery was admitted for.
- `service.ts`: add a `telegram.v1` branch beside `renderSlackMessage` and `renderDiscordMessage`.
- Headers: `content-type: application/json`, with no `webhook-*` signature headers, because the
  token is the secret. DNS pinning, no redirects, 10 s timeouts and URL redaction follow the
  shared transport policy.
- Diagnostics (`chatDiagnostics`, provider `'telegram'`, host `api.telegram.org` only):
  - read at most 1 KiB of JSON and keep only `ok`, `error_code` (integer),
    `parameters.retry_after` (integer) and `parameters.migrate_to_chat_id` (integer);
  - keep `description` only if it matches a fixed list: `Unauthorized`, `Forbidden: bot was blocked by the user`,
    `Forbidden: bot was kicked from the group chat`, `Forbidden: bot was kicked from the supergroup chat`,
    `Forbidden: bot is not a member of the channel chat`, `Forbidden: bot is not a member of the supergroup chat`,
    `Bad Request: chat not found`, `Bad Request: group chat was upgraded to a supergroup chat`;
  - discard everything else, and discard the body on `2xx`, which echoes the sent message.
- Outcome mapping:
  - `2xx` → success.
  - `401` (token revoked or regenerated in BotFather) → `gone`.
  - `403` with a known "blocked/kicked/not a member" description → `gone`.
  - `400` with `Bad Request: chat not found` → `gone`.
  - `400` with `migrate_to_chat_id` → `gone`. The kept diagnostic (with `migrate_to_chat_id`)
    shows the new chat ID in delivery history so the user can edit the receiver. Not rewritten
    automatically (out of scope).
  - `SendResult.providerCode` is typed for Discord's numeric codes, so transport reports a
    Telegram "gone" description as `providerGone: true` instead. That flag survives
    `redactWebhookDiagnostics`, including its `omitText` path, the same way `providerCode` does.
  - `429` → `rate_limited`. Prefer the `Retry-After` header and fall back to
    `parameters.retry_after` from the body, which Telegram always sends. This requires
    `retryAt` to accept a body-derived delay.
  - Other `400` → permanent; `5xx` → transient.
- Rate limits: Telegram allows roughly 1 message/s per chat and 20/min per group. The existing
  project token bucket and backoff cover this. The per-host test budget becomes shared by every
  Telegram receiver in a project (host `api.telegram.org`), the same as with Slack; this is acceptable.

### 5. Cockpit (`packages/web/src/routes/settings/`)

- "Destination" includes **Telegram chat (bot)**.
- For Telegram the form shows two fields instead of "Webhook URL":
  - **Bot token**: password-style input, placeholder `123456789:AA…`. On edit it may be left blank
    to keep the current token. The form builds `https://api.telegram.org/bot<token>/sendMessage`
    and sends it as `url`.
  - **Chat ID**: placeholder `-1001234567890 or @channelname`, prefilled on edit.
- Hint: "Create a bot with @BotFather, add it to your chat and paste its token. For a group or
  channel the chat ID starts with -100." Link to the official Bot API documentation.
- Pasting a full `https://api.telegram.org/bot…` URL into the token field is accepted and reduced
  to the token.
- Hide the local-network checkbox. Show no signing-key reveal or rotation. The card has a
  `Telegram` badge and shows `Telegram · <chat id>` as the destination. Message preview
  (`ChatPreview`) is Telegram-styled.
- `webhook-presentation.ts`: `'telegram.v1': 'Telegram'`.

### 5a. Connect chat

A bot cannot message a user who has never pressed Start. Telegram's deep links are the standard way
to make that press part of setup:

- **Route:** `POST /webhooks/telegram/connect` with
  `{ token | receiverId, code }` → `{ bot: { username, name }, chats[≤20], match? }`.
  - Stateless: the browser generates the one-time `code` (16 characters, `[A-Za-z0-9]`), and the
    server stores nothing.
  - An edit sends `receiverId`, so the saved token is reused and never returned.
  - Errors use the module's fixed messages: 400 for a bad token, 409 when another app or webhook
    consumes the bot's updates, 409 for a policy refusal, 502 when Telegram is unreachable.
- **Telegram calls:** `getMe` and `getUpdates`, through the transport policy (pinned DNS, no
  redirects, 10 s timeouts, 1 MiB body cap). The calls send no `offset`, so updates are not
  consumed for another consumer of the bot. They send no `allowed_updates` either, because
  Telegram remembers that setting for the bot.
- **What is kept from updates:** chat ID, type and title only; message text is read only to
  compare it with the code.
- **What counts as a match:** `/start <code>` or `/start@<bot> <code>` in a message, or the bare
  code in a channel post.
- **Cockpit:** "Connect chat" shows two links, `t.me/<bot>?start=<code>` (private chat) and
  `?startgroup=<code>` (group), plus the code to post in a channel. It polls every 3 s for 2 minutes
  and stops when the token changes or the form closes. A match fills the chat ID. Chats the bot
  already knows can be picked directly. Manual entry stays as the fallback.
- **Dry-run:** returns a synthetic bot and match, and sends nothing.
- **"Bot can't initiate conversation":** a 403 with this description stays in the diagnostics
  vocabulary as a permanent but not `gone` failure, because the user can fix it by pressing Start.

The token field and the URL field share one form value. Switching the destination type to or from
Telegram clears it, so a token never lands in a plain-text URL input. Pasting a bot URL and taking
the "Use Telegram" suggestion keeps it.

### 6. Setup guide

Add "Send to Telegram" to `packages/cezar/docs/webhooks.md`:

1. Create a bot with @BotFather and copy its token.
2. Add the bot to the group or channel. In a channel it must be an admin with the post-message right.
3. Find the chat ID: send a message, then open `https://api.telegram.org/bot<token>/getUpdates`
   in a browser.
4. Paste the token and chat ID, then Test, then Activate.

The guide also states that the token is a secret, explains Minimal vs Standard in Telegram, and
explains what to do after a group upgrade. `docs/site` has no webhooks page yet, so there is nothing to update there.

## Validation

- **Contract:** accepts valid token URL and chat ID pairs; rejects a missing or extraneous
  `telegramChatId`, a query string, a wrong host or path, and `allowLocalNetwork`; rejects a
  Telegram URL under `cezar.json.v1`.
- **Parity:** `contract-parity*.test.ts` and `typed-bodies.test.ts` stay green. The optional
  response field is absent for non-Telegram receivers.
- **Renderer:** escaping of `<>&`, the 4096-character limit counted after entity parsing (with
  no clip inside a tag or entity), dropping questions before clipping, privacy (Minimal carries
  no questions or error), `@` neutralization, and link scheme filtering.
- **Redaction:** neither the token, `bot<token>` nor the full URL ever appears in history, logs or
  diagnostics. Include a case where a Telegram error body echoes the token.
- **Transport:** closed diagnostics vocabulary; `retry_after` from the body; `gone` for 401, 403
  known descriptions, chat-not-found and migration; `2xx` body discarded.
- **Registry:** a `telegramChatId` edit bumps `deliveryRevision` and makes the receiver inactive;
  an old `endpoints.json` without the field still loads.
- **Cockpit:** form fields, token-from-URL reduction, card destination text, and the edit flow
  that keeps the token.
- **Regression proof:** run the redaction test with the Telegram branch of `receiverSecretValues`
  stashed and confirm it fails (AGENTS.md § Changing a mechanism that already works).
- `CEZ_DRY_RUN=1` substitutes synthetic success and sends nothing. It validates local flows, not
  provider delivery.

Live provider acceptance requires explicit authorization and follows the Discord spec's
procedure: a dedicated test bot and test chat, an isolated project, `CEZ_WEBHOOKS=1`, dry-run
disabled, and benign tasks only. Verify attention, finished and failed messages in the chat
against delivery history. With separate authorization, revoke the token in BotFather, confirm
`401` disables the receiver, then pause it.

## Risks

- **Token = full control of the bot**, not just posting to one chat: it can read updates and post
  anywhere the bot is a member. Store it only in the private URL, redact it in every form, and
  say this in the activation disclosure and the guide. Recommend a dedicated bot for cezar.
- **Third-party server:** Telegram sees titles, questions and errors under the Standard profile.
  The activation flow discloses this, as for Slack and Discord.
- **Wrong chat ID:** a typo can deliver into another chat the bot belongs to. Mitigations: Test is
  required before Activate, the test message names the receiver, and the card shows the chat ID.
- **Downgrade (resolved, accepted):** `readState` treats an unknown format or key in
  `endpoints.json` as an integrity error for the whole registry. Outbound webhooks (#1604) are not
  in any release (`release/v0.16.x` does not contain them), and `discord.v1` was added on the same
  terms. No per-receiver salvage is added.
