# Telegram setup wizard and task replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guided Telegram setup flow and complete the round trip for tasks started from Telegram, with safe replies to the originating chat.

**Architecture:** Extend the existing Telegram receiver, pairing, grant, state, renderer, and shared-budget seams. Stage 1 is a UI orchestration layer over validated bot/chat/pairing routes. Stage 2 records a durable source correlation for Telegram-originated tasks and routes acknowledgements, questions, progress, and final results through the existing Telegram dispatcher without creating a second task executor.

**Tech Stack:** TypeScript, Hono, Zod contracts, React 19, Vitest, existing Telegram client/poller/dispatcher, existing Cezar RunManager and account/provider gates.

**Spec:** `docs/superpowers/specs/2026-10-29-telegram-setup-and-replies-design.md`

## Global Constraints

- Every new HTTP request and response shape is a Zod schema in `packages/contract`, with types inferred from the schema.
- Every route is chained into its route family, mounted under `/api/v1`, and validated with route middleware.
- Existing receiver, vault, lease, poller, state, grant, limiter, renderer, account, provider, and redaction seams remain authoritative.
- Inbound task control remains explicit opt-in; notifications-only receivers must not start task control.
- A task effect is durably claimed and authorized before it is reported as applied; Telegram delivery retry never reruns the task effect.
- No token, raw prompt, hidden path, or unredacted provider output may reach Telegram or durable source metadata.
- Existing Slack, Discord, JSON, outbound Telegram, hosted mode, and flag-off behavior must remain unchanged.
- All new state transitions define behavior for activation, disable, conflict, blocked, vault failure, restart, revoke, reset, and uncertain recovery.
- All tests and commands run with `CEZ_REMOTE` unset; bounded commands use `timeout 300`.

## Review Focus

- A wizard must leave reset/orphan/damaged-state recovery reachable when there are zero receivers; test empty-state UI and route behavior in `telegram-inbound.test.tsx`.
- A stale, revoked, disabled, conflicted, or changed-generation Telegram source must not mutate a run; test each freshness boundary in the source authorization suite.
- Duplicate Telegram updates and delivery retries must create at most one task effect; test durable claim/replay behavior in the source journal suite.
- Near-limit, redacted, escaped, and failed Telegram output must remain readable and must not leak sensitive data; test renderer and dispatcher boundaries.
- Recreated services, vault failures, rate limits, and restarts must preserve safe delivery behavior without silently revoking grants; test lifecycle and shared-budget recovery.

---

### Task 1: Stage 1 backend setup orchestration

**Files:**
- Modify: `packages/contract/src/telegram.ts`
- Modify: `packages/cezar/src/telegram/service.ts`
- Modify: `packages/cezar/src/server/telegram.ts`
- Modify: `packages/cezar/src/server/telegram-bindings.ts` only if the existing binding family needs a wizard action
- Test: `packages/cezar/src/telegram/service.test.ts`
- Test: `packages/cezar/src/server/telegram.test.ts`
- Test: `packages/cezar/src/server/contract-parity.telegram.test.ts`

**Interfaces:**
- Consumes existing `EndpointRegistry`, `TelegramSecrets`, `TelegramInbound`, pairing, grant, and ownership services.
- Produces typed wizard operations for begin/connect, bot metadata, private-chat discovery, token/chat test, permission selection, activation, and recovery diagnostics.
- Keeps existing pairing routes compatible; new orchestration responses use `telegramDomainErrorSchema` and inferred types.

- [ ] **Step 1: Add failing contract and route tests** for begin/connect status, masked bot metadata, private-chat candidate discovery, permission review, activation, and actionable error codes (`invalid_token`, `pairing_expired`, `conflict`, `blocked`, `vault_unavailable`, `damaged_state`, `insufficient_permission`). Assert project aliases, hosted/flag gates, 404/409 scope behavior, and no token in responses.
- [ ] **Step 2: Run the focused tests to verify the new cases fail** with the current route/service surface.
- [ ] **Step 3: Add Zod request/response schemas and inferred types** in `packages/contract/src/telegram.ts`; chain routes and middleware validation in `server/telegram.ts`; preserve existing route family and domain-error behavior.
- [ ] **Step 4: Implement service orchestration** using existing connect cache, `getMe`, `/start` private-chat discovery, pairing status, grant permissions, activation, reset, and orphan diagnostics. Keep transient vault/network failures retryable and never persist plaintext tokens outside the vault.
- [ ] **Step 5: Run contract parity, route, and service tests** and verify all new cases pass with existing Telegram routes green.
- [ ] **Step 6: Commit** with `feat: add Telegram setup orchestration`.

### Task 2: Stage 1 setup wizard UI

**Files:**
- Modify: `packages/web/src/routes/settings/telegram-inbound.tsx`
- Modify: `packages/web/src/routes/settings/telegram-connect.tsx`
- Modify: `packages/web/src/routes/settings/webhooks-section.tsx` only for placement and empty-state reachability
- Test: `packages/web/src/routes/settings/telegram-inbound.test.tsx`
- Test: `packages/web/src/routes/settings/webhooks-section.test.tsx`

**Interfaces:**
- Consumes Task 1 typed API operations and existing settings query/invalidation patterns.
- Produces a wizard with explicit notification-only vs task-control mode, token validation, deep-link chat discovery, permission review, activation, completion health, and recovery actions.

- [ ] **Step 1: Add failing component tests** for zero receivers, mode selection, token validation, deep-link discovery, expired pairing retry, least-privilege permissions, review warning, activation success, and actionable failure states. Assert that token input is cleared after submission and that reset/orphan actions remain visible.
- [ ] **Step 2: Run the focused UI tests to verify the cases fail** before adding wizard behavior.
- [ ] **Step 3: Implement the wizard state machine** with explicit states `idle`, `token`, `discovering`, `candidate`, `permissions`, `review`, `activating`, `complete`, and `recovery`; keep transient values local and never render the token after submission.
- [ ] **Step 4: Integrate existing Connect/pairing/reset diagnostics** and gate inbound task-control copy and controls on the selected mode and current availability.
- [ ] **Step 5: Run the focused settings tests** and verify keyboard navigation, error recovery, empty state, and no-regression behavior for existing receiver cards.
- [ ] **Step 6: Commit** with `feat: add guided Telegram setup wizard`.

### Task 3: Stage 2 Telegram source correlation and task creation

**Files:**
- Create: `packages/contract/src/telegram-tasks.ts`
- Modify: `packages/contract/src/index.ts` to export the task schemas
- Modify: `packages/cezar/src/telegram/state.ts`
- Modify: `packages/cezar/src/telegram/authorization.ts`
- Modify: `packages/cezar/src/telegram/conversation.ts`
- Modify: `packages/cezar/src/server/run-messages.ts` and the existing task-creation seam where source attribution is attached
- Test: `packages/cezar/src/telegram/state.test.ts`
- Test: `packages/cezar/src/telegram/authorization.test.ts`
- Test: `packages/cezar/src/telegram/conversation.test.ts`
- Test: `packages/cezar/src/telegram/roundtrip-source.test.ts`

**Interfaces:**
- Consumes Task 1's verified receiver/grant and the existing `deliverUserMessage`, account, provider, and run creation seams.
- Produces `TelegramSourceRecord` with project, receiver, grant generation, chat ID, user ID, source message ID, episode/request ID, run ID, state, and timestamps; exposes only redacted status projections.
- Source creation returns a durable claim/result that lets duplicate updates be recognized before task creation.

- [ ] **Step 1: Add failing state and source-authorization tests** for one source record per accepted update, duplicate update rejection, source-to-run attribution, private/group sender checks, fresh request/episode checks, and disabled/revoked/generation-changed rejection.
- [ ] **Step 2: Run the focused tests to verify duplicate and stale-source cases fail** against the current conversation path.
- [ ] **Step 3: Extend the durable inbound state schema and single-writer mutations** with bounded source records and claim states (`received`, `claimed`, `uncertain`, `finished`, `expired`, `delivery_failed`), preserving compaction and recovery rules.
- [ ] **Step 4: Add a conversation-to-task adapter** that authorizes the current grant, creates exactly one run through the existing task seam, records source attribution, and sends an acknowledgement only after durable claim; use the receiver's project and paired user's saved account by default. Put the new source request/response schemas in `telegram-tasks.ts`, leaving Task 1's wizard schemas untouched.
- [ ] **Step 5: Re-run authorization, state, conversation, and round-trip tests** including replay after crash/recovery and account/provider refusal.
- [ ] **Step 6: Commit** with `feat: correlate Telegram tasks with source chats`.

### Task 4: Stage 2 response and progress delivery

**Files:**
- Modify: `packages/cezar/src/telegram/runtime.ts`
- Modify: `packages/cezar/src/telegram/dispatcher.ts`
- Modify: `packages/cezar/src/telegram/send-budget.ts` only if source replies need a new ticket class
- Modify: `packages/cezar/src/webhooks/telegram.ts`
- Test: `packages/cezar/src/telegram/dispatcher.test.ts`
- Test: `packages/cezar/src/telegram/send-budget.test.ts`
- Test: `packages/cezar/src/telegram/roundtrip.test.ts`
- Test: `packages/cezar/src/webhooks/telegram.test.ts`

**Interfaces:**
- Consumes Task 3 source records and run attribution.
- Produces bounded Telegram messages for accepted, progress, input-required, success, cancel, failure, expiry, unauthorized, and unavailable states.
- Consumes the existing runtime/run-transition callback seam rather than modifying source creation or run-message ownership. Uses the shared global Telegram budget, renderer, redaction, escaping, link sizing, retry, and delivery-failure journal; no direct transport call bypasses the dispatcher.

- [ ] **Step 1: Add failing delivery tests** for acknowledgement, coalesced progress, final result, question/reply hint, cancellation, failure, expiry, long-output link fallback, shared-budget ordering, 429 cooldown, and delivery retry without rerunning the task. Use the source record interface produced by Task 3; do not change source state or task creation here.
- [ ] **Step 2: Run the focused delivery tests to verify they fail** before wiring run transitions.
- [ ] **Step 3: Implement source reply rendering** with one acknowledgement, an editable status message where Telegram permits, and a final message; fall back to bounded follow-ups, omit optional hints before truncating required content, and use existing redaction/escaping.
- [ ] **Step 4: Wire run transitions and receipt completion** to source records; make status publication idempotent and coalesced, and mark delivery failures separately from task failures.
- [ ] **Step 5: Verify dispatcher/budget fairness** across webhook deliveries and source replies, including recreated services and persisted 429 cooldowns.
- [ ] **Step 6: Run focused delivery, renderer, and round-trip tests** and commit with `feat: reply to Telegram-originated tasks`.

### Task 5: Documentation, browser flow, integration, and release checks

**Files:**
- Modify: `docs/site/content/docs/03-features/settings-and-projects/telegram-replies.mdx`
- Modify: `packages/cezar/docs/webhooks.md`
- Modify: `.env.example` and `docs/reference.md` only if the wizard introduces a user-facing environment change
- Modify: `packages/web/e2e/telegram-inbound.config.ts`
- Modify: `packages/web/e2e/telegram-inbound-server.mjs`
- Test: `packages/web/e2e/telegram-inbound.spec.ts` and relevant docs checks

**Interfaces:**
- Consumes the complete Stage 1 and Stage 2 route/UI behavior.
- Produces user documentation, browser coverage for setup and a Telegram-originated task reply, and a release checklist with no new required configuration.

- [ ] **Step 1: Add failing browser assertions** for empty-state setup, token test, private-chat pairing, activation, task submission, acknowledgement, question/final response, and revoked-source refusal using a deterministic Telegram fixture.
- [ ] **Step 2: Run the browser test to verify the new assertions fail** against the current implementation.
- [ ] **Step 3: Update documentation** with the two setup modes, shell/cost warning, pairing/privacy behavior, troubleshooting, reset/orphan recovery, and Telegram-originated task lifecycle. Document exact `Confirm`/Reply wording.
- [ ] **Step 4: Implement and stabilize the browser fixture** for `getMe`, `/start`, task updates, callbacks, status edits, and delivery failures without real credentials.
- [ ] **Step 5: Run browser, docs, typecheck, build, package, unit, focused, and full tests** with `CEZ_REMOTE` unset; run one controlled live Telegram smoke test only with explicit test credentials and remove all scratch state afterward.
- [ ] **Step 6: Commit** with `test/docs: cover Telegram setup and task replies`.

## Five validation iterations after implementation

After all five tasks are merged, perform these five sequential iterations. Each iteration records findings, fixes them in a separate commit, reruns the named checks, and does not proceed until the iteration is green.

1. **Business behavior:** verify notifications-only and task-control journeys, project/account selection, task lifecycle messages, question/continue/cancel semantics, error language, and compatibility with existing outbound receivers.
2. **Technical correctness:** inspect all construction sites and route aliases; run full tests, typecheck, build/package, contract parity, state recovery, duplicate update, restart, and limiter tests.
3. **Security and privacy:** review token/vault boundaries, SSRF policy, origin/scope gates, grant freshness, replay/claim semantics, redaction, HTML escaping, group privacy, audit attribution, and secret scanning.
4. **UX/UI and accessibility:** exercise empty, loading, retry, expired, disabled, conflict, orphan, and success states; test keyboard flow, readable copy, bounded IDs, mobile Telegram output, and browser e2e.
5. **Simplicity and operations:** remove duplicated state/resolvers, simplify setup copy and defaults, verify no new mandatory configuration, measure bounded queues/status frequency, validate recovery after vault/network/429/restart faults, and rerun the complete release checklist.

Each iteration must end with: a written finding list, fixes or an explicit ruling, focused regression tests, full relevant validation, and a clean `git diff --check`.
