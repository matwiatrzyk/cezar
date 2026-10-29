# Task 5 docs, browser, integration and release report

## Result

- Documented the shipped two-stage Telegram setup, exact private/group approval
  wording, shell/cost warning, notifications-only boundary, troubleshooting and
  reset/orphan recovery in the user guide and webhook guide.
- Added the additive Telegram setup/source-reply compatibility note to
  `BACKWARD_COMPATIBILITY.md`.
- Extended the deterministic Telegram browser fixture to capture fake outbound
  messages, inject a private task only after pairing approval, and settle the
  task locally without credentials or network access.
- Extended the browser flow to verify a Telegram-originated run reaches `done`
  and retains private source attribution for chat/user `456`.

## Verification

- `node --check packages/web/e2e/telegram-inbound-server.mjs` — passed.
- `git diff --check` — passed.
- `npx e2e run --config packages/web/e2e/telegram-inbound.config.ts` — 1 test passed.
- Focused Telegram/UI Vitest suite — 5 files, 63 tests passed.
- `npm run build:web` — passed.
- `node docs/site/scripts/check.mjs` — 205 pages passed.
- `npm run docs:check` could not run its install wrapper because this environment
  rejects project-scoped npm scripts (`EALLOWSCRIPTS`); the checker itself passed
  directly as above.
- `npm run typecheck:web` and `npm run typecheck:server` remain blocked by
  pre-existing contract/runtime drift outside Task 5 (missing generated route
  members in web; two `TelegramSourceRecord.state` errors in runtime.ts).
