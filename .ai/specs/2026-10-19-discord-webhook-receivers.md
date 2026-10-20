# Discord receivers for outbound webhooks — basic scope

Status: implemented (automated validation; live channel acceptance pending) · 2026-10-19 · extends `2026-10-12-outbound-webhooks.md`, mirrors
`2026-10-19-slack-webhook-receivers.md`

## Goal

A user pastes a Discord channel **Webhook URL** (Server Settings → Integrations → Webhooks) into
Settings → Webhooks and gets readable task notifications in that channel — no relay, no bot, no
OAuth. Admission, grace, freshness, retries, suspension, history, privacy profiles and ownership
are the existing pipeline, unchanged.

## Out of scope (basic)

Discord bot / application / OAuth, channel picker, buttons or answering a question from Discord,
posting into a thread or forum (`thread_id`, `thread_name`), custom username/avatar per message,
mentions/role pings, editing a message as the task progresses, the `/slack` and `/github`
compatibility endpoints.

## Shared groundwork with Slack

Both plans add a value to the same receiver `format` enum and the same render-at-send hook. Whichever
lands first introduces the mechanism (contract enum, `format` on the delivery record, per-format
render + header selection in `service.ts`/`transport.ts`, `format` in the endpoints reset list, the
"Destination" field in the form). The second adds only its own renderer, URL rule, diagnostics rule
and UI copy. If Discord lands first, apply sections 1 and 3 of the Slack plan with `discord.v1`.

## Design

### 1. Contract

- `packages/contract/src/webhooks.ts`: `format` enum gains `'discord.v1'`
  (`'cezar.json.v1' | 'slack.v1' | 'discord.v1'`, default `cezar.json.v1`).
- Refinement for `discord.v1`: `https://` on `discord.com`, `discordapp.com`, `ptb.discord.com`
  or `canary.discord.com`; path exactly `/api/webhooks/<snowflake 17–20 digits>/<token [A-Za-z0-9_-]{60,80}>`
  (an optional `/api/v10/webhooks/…` version segment accepted); no port, no query, no fragment;
  `allowLocalNetwork === false`. Normalize to `https://discord.com/api/webhooks/<id>/<token>` on save.
- A Discord URL with `format: 'cezar.json.v1'` is rejected with "Choose Discord as the destination
  type" — it could only ever answer `400`.
- BACKWARD_COMPATIBILITY.md: note the widened enum.

### 2. Rendering (`webhooks/discord.ts`, new)

`renderDiscordMessage(eventJson: string, ctx): string` maps the **already rendered, redacted,
profile-filtered** cezar event body to a Discord execute-webhook body. Discord never sees a field
the cezar payload for that profile does not carry.

```json
{ "content": "Needs your input · <title or task id8>",
  "allowed_mentions": { "parse": [] },
  "embeds": [{ "title": "…", "description": "…", "color": 15105570, "timestamp": "<occurredAt>",
               "url": "<PR, issue or hosted cockpit link, if any>",
               "fields": [{ "name": "Project", "value": "…", "inline": true },
                          { "name": "Status", "value": "running → waiting", "inline": true },
                          { "name": "Task", "value": "`a1b2c3d4`", "inline": true }],
               "footer": { "text": "cezar" } }] }
```

- `allowed_mentions: { parse: [] }` always — a task title or error containing `@everyone`/`<@id>`
  must never ping anyone. Also neutralize mention syntax in text (zero-width space after `@`).
- Escape Discord markdown (`\ * _ ~ \` | >` and leading `#`/`-`) in every interpolated string.
- Colour per event: attention amber, review blue, finished green, failed red, cancelled grey.
- Standard profile: questions + options as a numbered list in `description`; `task.failed`
  message in a field. Minimal: neither.
- Limits enforced by the renderer: `content` ≤ 2000, title ≤ 256, description ≤ 4096, ≤ 25 fields,
  field value ≤ 1024, all embed text ≤ 6000; drop trailing questions first, then clip, then fall
  back to `content` only.
- Labels reuse the UI wording; `webhook.test` → "cezar is connected to this channel" + receiver name.

### 3. Send path

- `format` snapshot on the delivery record (shared groundwork); render with `renderDiscordMessage`
  at send time; history keeps the cezar JSON.
- Headers: `content-type: application/json`, no `webhook-*` signature headers (the URL is the
  secret). DNS pinning, no redirects, 10 s timeouts, URL redaction unchanged. Add `?wait=true` internally at send time so Discord confirms that the message was saved
  before cezar records success (normally `200 OK`). The stored URL still has no query.
  Discard the successful response body; never retain the returned message content.
- Diagnostics: for the Discord hosts only, read ≤ 512 bytes of a JSON body and keep only
  `code` (integer) and `message` if it is one of Discord's fixed strings (`Unknown Webhook`,
  `Invalid Webhook Token`, `Invalid Form Body`, `You are being rate limited.`). Everything else
  dropped, as today.
- Outcome mapping — differs from the generic table in one place:
  - `404` with `code 10015` (Unknown Webhook) or `401` with `50027` (Invalid Webhook Token) → `gone`
    → receiver `disabled`: the webhook was deleted in Discord and will never come back.
  - `429` → `rate_limited` using the `Retry-After` header (Discord sends seconds); `retry_after`
    from the body is not needed. Global/channel limits (≈ 5 req / 2 s per webhook) are covered by
    the existing backoff.
  - `400` (`50035`, our bug) → permanent; `5xx` → transient; `2xx` → success.

### 4. Cockpit

- "Destination" gains **Discord channel (Webhook URL)**.
- Discord: placeholder `https://discord.com/api/webhooks/…`, one sentence + link to Discord's
  "Intro to Webhooks" support article, local-network checkbox hidden, Discord-style embed preview.
- No signing-key reveal or rotation for Discord receivers; `Discord` badge on the card.
- Pasting a Discord URL under "Custom receiver" shows an inline hint offering to switch.

### 5. Docs

`packages/cezar/docs/webhooks.md`: "Send to Discord" (create webhook in channel → paste URL →
Test → Activate; Minimal vs Standard in Discord; URL is a secret; mentions never ping). No new env
var — behind `CEZ_WEBHOOKS=1`, `.env.example` untouched.

## Implementation order (TDD, each step green before the next)

1. Shared groundwork if not yet present (see Slack plan, steps 1, 3, 4).
2. Contract: `discord.v1`, URL rule + normalization (host variants, versioned path, rejects:
   query, `/slack`, `/github`, short token, http).
3. `discord.ts` renderer: golden tests per event × profile; markdown and mention neutralization;
   every limit; "never adds a field the cezar body lacks" property test.
4. Transport/service: headers, diagnostics allowlist, `10015`/`50027` → `gone`, confirmed `200` success with `wait=true`,
   `429` + `Retry-After`.
5. UI: destination option, preview, badge, hidden key flows; component tests.
6. Docs + BC note.
7. Gate: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.
8. Manual: a real Discord webhook (user-provided test channel): Test → Activate → attention /
   finished / failed on a dry-run task; delete the webhook in Discord and confirm the receiver
   becomes `disabled`.

## Risks

- URL = credential (anyone with it can post). Already in `secrets()`, masked, redacted — keep a
  test that the token never reaches history or logs, including the normalized form.
- A third-party server sees titles/questions/errors under Standard — repeat the warning.
- Mention injection from task text — closed by `allowed_mentions` plus text neutralization; pinned
  by a test with `@everyone`, `<@123>`, `<@&123>`.

## Implementation notes (2026-10-19)

Both destinations share a format snapshot on admissions and manual tests. Legacy persisted
custom receivers remain readable even on chat hosts; new create/edit requests enforce the
selected destination's URL rules. Chat creation returns an empty `secret` for API compatibility,
and key rotation is rejected. Switching from chat to custom creates a fresh key; the edit
confirmation instructs the user to rotate and copy it before connecting the custom receiver.

Provider diagnostics use a closed vocabulary. Discord credentials are redacted by token as well
as full URL, covering normalized host/path aliases. Invalid stored chat payloads terminate as
`payload_invalid` before a send claim is published. Retained-URL format mismatches return 409.

Automated acceptance includes renderer limits/privacy, contract/transport/service tests and
`npx e2e run --config packages/web/e2e/chat-webhooks.config.ts` (dry-run browser flow, isolated
repository). Real channel acceptance is still pending user-provided test-channel credentials;
automated checks do not claim that Slack or Discord actually displayed a message.
