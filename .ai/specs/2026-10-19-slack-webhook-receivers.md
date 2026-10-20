# Slack receivers for outbound webhooks — basic scope

Status: implemented (automated validation; live channel acceptance pending) · 2026-10-19 · extends `2026-10-12-outbound-webhooks.md`

## Goal

A user pastes a Slack **Incoming Webhook URL** into Settings → Webhooks and gets readable task
notifications in a Slack channel — no relay, no cezar-managed Slack app or OAuth (the user installs an Incoming Webhook app in Slack). Everything else (admission,
grace, freshness, retries, suspension, history, privacy profiles, ownership) is the existing
pipeline, unchanged.

## Out of scope (basic)

Slack app / OAuth / bot token, channel picker, interactive buttons or answering a question from
Slack, threading per task, mentions, per-event channels, Discord/Teams, Enterprise Grid
(`hooks.slack-gov.com`).

## Design

### 1. Receiver format (contract)

- `packages/contract/src/webhooks.ts`: add `format: z.enum(['cezar.json.v1', 'slack.v1']).default('cezar.json.v1')`
  to the receiver settings; widen the public receiver's `format` literal to the same enum. Old
  `endpoints.json` rows parse (default). The public `webhookEventSchema` / `webhooks.schema.json`
  stay unchanged — Slack is a rendering of that event, not a new event.
- Refinement: `format === 'slack.v1'` ⇒ URL is `https://hooks.slack.com/services/<T…>/<B…>/<token>`
  (exact host, no port/query) and `allowLocalNetwork === false`. A `hooks.slack.com` URL with
  `format: 'cezar.json.v1'` is rejected with "Choose Slack as the destination type" — it could only
  ever answer `400 invalid_payload`.
- `endpoints.ts`: add `format` to the delivery-relevant `fields` list, so changing it resets the
  receiver to `inactive` like any other delivery change.
- BACKWARD_COMPATIBILITY.md: note the widened `format` enum.

### 2. Rendering (`webhooks/slack.ts`, new)

`renderSlackMessage(eventJson: string, ctx): string` takes the **already rendered, redacted,
profile-filtered** cezar event body and maps it to Slack JSON. Privacy stays single-source: Slack
can never see a field the cezar payload for that profile would not carry.

- `text` (fallback / notification line): `<label> · <title or task id8> · <projectId>`.
- `blocks`: one `section` (mrkdwn: label, title, status `previous → current`), one `context`
  (project, task id, time), optional `section` with questions + options (standard profile only),
  optional error message (`task.failed`, standard only), optional actions-free link line for
  PR / issue / cockpit (cockpit only when the event carries it, i.e. hosted).
- Labels reuse the UI wording (`Needs your input`, `Ready for review`, `Task finished`,
  `Task failed`, `Task cancelled`, `Test message`).
- Escape `&`, `<`, `>` in every interpolated string; clip each text block to 2900 chars and the
  question list to what fits; whole body ≤ 40 KB (Slack limit) — fallback to `text` only.
- `webhook.test` → "cezar is connected to this channel" with the receiver name.

### 3. Send path

- Snapshot `format` on the delivery record (optional field, default cezar) at admission, so a
  retry renders what was admitted even if the receiver is later edited.
- `service.ts` (line ~471, where the body is rendered for sending): if `format === 'slack.v1'`,
  wrap the cezar body with `renderSlackMessage`. History keeps the cezar JSON (inspectable, same
  as today).
- `transport.ts`: for Slack, send `content-type: application/json` without `webhook-id` /
  `webhook-timestamp` / `webhook-signature` (the URL itself is the secret; Slack ignores them and
  signing a body nobody verifies only adds confusion). DNS pinning, no redirects, 10 s timeouts,
  redaction of the URL — unchanged.
- Response diagnostics: today a path-bearing URL never has its body read. For
  `hooks.slack.com` only, read ≤ 64 bytes and keep it only if it matches `^[a-z_]{1,64}$` (Slack's
  fixed error codes: `invalid_token`, `no_service`, `channel_not_found`, `channel_is_archived`,
  `invalid_payload`, `action_prohibited`). Anything else is dropped as now.
- Outcome mapping: existing table already fits — 2xx success, 410 (`channel_is_archived`) gone →
  `disabled`, 429 + `Retry-After` rate-limited, 5xx transient, 400/403/404 permanent. No change
  beyond a test pinning it for Slack statuses.

### 4. Cockpit (`webhook-form.tsx`, `webhook-card.tsx`)

- New first field **Destination**: "Custom receiver (signed cezar JSON)" / "Slack channel
  (Incoming Webhook)".
- Slack: placeholder `https://hooks.slack.com/services/…`, one sentence + link to Slack's
  "Sending messages using incoming webhooks" page, local-network checkbox hidden, JSON preview
  replaced by a Slack-style preview of the example message.
- After create: no signing-key reveal for Slack ("Slack receivers do not use a signing key");
  rotate-key action hidden for Slack receivers.
- Card shows a `Slack` badge next to the masked destination.
- Typing a `hooks.slack.com` URL while "Custom receiver" is selected shows an inline hint and
  offers to switch.

### 5. Docs

`packages/cezar/docs/webhooks.md`: a short "Send to Slack" section (create an Incoming Webhook in
Slack → paste URL → Test → Activate; what Minimal vs Standard shows in Slack; the URL is a secret).
No new env var: it stays behind `CEZ_WEBHOOKS=1`, so `.env.example` is untouched.

## Implementation order (TDD, each step green before the next)

1. Contract: `format` enum + Slack URL refinement + old-row parse test; `contract-parity` and
   `typed-bodies` green.
2. `slack.ts` renderer: golden tests per event × profile, escaping, clipping, 40 KB fallback,
   "never adds a field the cezar body lacks" property test.
3. Delivery snapshot + service wiring + transport headers / Slack diagnostics allowlist; tests with
   the existing mock `send` and a loopback server (local-network bypass only in tests).
4. Endpoints: `format` change resets to inactive.
5. UI: form, preview, card badge, hidden key flows; component tests.
6. Docs + BC note.
7. Gate: `npm run typecheck`, `npm test`, `npm run test:unit`, `npm run build`, `npm run test:package`.
8. Manual: one real Slack Incoming Webhook (user-provided), Test → Activate → trigger
   attention / finished / failed on a dry-run task, check channel; verify `channel_is_archived`
   disables the receiver.

## Risks

- The Slack URL is the credential: it is already treated as a secret (`secrets()` includes
  `item.url`, masked in UI, redacted from diagnostics) — keep a test that it never appears in
  history or logs.
- Slack's 1 msg/s per webhook: bursts rely on the existing 429/`Retry-After` path.
- Standard profile puts task titles/questions/errors into a third-party workspace — the form
  already warns; repeat it for Slack.

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
