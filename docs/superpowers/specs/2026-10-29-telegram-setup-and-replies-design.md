# Telegram setup wizard and task replies design

## Intent

Make Telegram useful without requiring the operator to understand webhook receiver fields, chat IDs, pairing revisions, or permission generations. The existing Telegram receiver and pairing implementation remains the source of truth; the new work adds a guided setup flow and then completes the round trip for tasks started from Telegram.

The user should be able to connect a bot, connect a private chat, choose what that person may do, and activate the connection from one guided flow. In the second stage, a task started from that Telegram chat should produce progress and final responses in the same chat, while retaining the existing Cezar account, provider, authorization, redaction, and delivery guarantees.

## Goals

- Provide a setup wizard inside the existing Telegram settings surface.
- Support two explicit modes: notifications only, or notifications plus Telegram task control.
- Validate the token before activation and discover a private chat through `/start` rather than asking for a numeric chat ID.
- Make pairing, permissions, activation, reset, and failure recovery understandable from the UI.
- Correlate a Telegram-originated task with its source chat and source message.
- Send accepted, progress, input-required, success, cancellation, failure, and expiry responses back to the source chat.
- Preserve at-most-once effects, current grant checks, account/provider gates, redaction, rate limits, retry behavior, and durable uncertainty handling.
- Keep outbound-only users working without enabling inbound control.

## Non-goals

- Replacing the existing receiver registry, vault, lease, limiter, poller, pairing state, or grant model.
- Supporting arbitrary Telegram chats as task sources without pairing and grants.
- Allowing a Telegram user to create a new Cezar account or bypass cockpit account/provider policy.
- Replacing the cockpit as the place for bot-token rotation, project selection, or global policy.
- Adding a second Telegram integration or a second source of truth for permissions.
- Sending unredacted prompts, filesystem paths, secrets, or raw provider output to Telegram.

## Anti-goals

- A chat command must never become an unaudited shell or account-control channel.
- A user must never receive a success message for an effect that was not durably claimed and authorized.
- A transient Telegram, vault, disk, or provider failure must not silently revoke a valid pairing.
- A setup wizard must not hide a disabled, damaged, orphaned, or conflicted bot; it must expose recovery.
- The feature must not turn on inbound polling or incur Telegram traffic until the operator explicitly activates it.

## Chosen approach

Extend the existing Telegram settings and service seams. The wizard is a UI orchestration layer over the current validated routes. Stage 1 ends with an active receiver and a verified grant. Stage 2 consumes that same grant and adds a source-correlation record to the task/run path; it does not create a parallel Telegram executor.

The alternative of a separate setup application would duplicate receiver and pairing state. Documentation-only changes would not remove the current setup friction. The existing settings surface is therefore the only approach that keeps the security model and failure behavior coherent.

## User experience

### Stage 1: setup wizard

1. The Telegram settings panel offers **Connect Telegram** even when there are no receivers. Existing reset, disconnect, orphan, and damaged-state diagnostics remain reachable.
2. The operator chooses **Notifications only** or **Notifications and task control**. The second choice explains that Telegram text can be sent to the coding agent and may start paid work, subject to the same account and provider controls as the cockpit.
3. The operator pastes a BotFather token. The client submits it through the existing connect/test path; the server validates the token with `getMe`, stores it only in the vault, and returns masked bot metadata.
4. The operator opens the generated deep link and sends `/start` in a private chat. The server discovers the chat, verifies that the sender owns the private chat, and presents the candidate in the wizard.
5. The operator chooses permissions from the existing closed set. Defaults are least privilege: receive notifications and read status; task control is opt-in.
6. The wizard shows a review page with bot, chat, mode, permissions, and the shell/cost warning. Activation is a deliberate final action.
7. Completion shows health, last test, current grant, and recovery actions. Errors map to actionable states: invalid token, bot conflict, blocked bot, chat not found, pairing expired, vault unavailable, damaged state, or insufficient permission.

Group pairing remains an explicit advanced path with a privacy warning and membership confirmation. It is not silently selected by the private-chat wizard.

### Stage 2: Telegram-originated tasks

1. A paired user sends an accepted command or replies to a Cezar message in the authorized private chat. Commands must use the existing parser and group addressing rules.
2. The service creates a source record containing project, receiver, grant generation, Telegram chat ID, user ID, source message ID, episode/request ID, and the Cezar run ID once created. The source record is bounded and durable enough to recover an uncertain send without repeating the task effect.
3. Telegram receives an immediate acknowledgement such as **Accepted** or **Needs confirmation**. The acknowledgement is sent through the shared Telegram budget and is not a second task execution.
4. Progress updates are coalesced and bounded. The default is one status message per meaningful state transition, with edits or a compact follow-up when Telegram limits or chat readability make edits unsuitable.
5. A task asking for input produces the existing question/options format and a Reply instruction tied to the source message. The response parser accepts only a fresh reply or approved command from the same authorized user/chat.
6. Final states map to concise Telegram messages: completed, cancelled, failed, expired, unauthorized, or unavailable. Long output is redacted, escaped, truncated, and linked to the cockpit when appropriate.
7. Continue, cancel, and confirmation actions re-check the current grant, receiver generation, account, provider, and run state immediately before applying the effect. A stale or revoked source receives an explanatory refusal and cannot mutate the run.
8. If Telegram delivery fails after the task effect is durably claimed, the task is not rerun. The source record and audit activity expose the delivery failure for retry or cockpit inspection.

## Data and service boundaries

- **Wizard state:** transient client state only; durable bot credentials and pairing state remain in the existing vault, endpoint registry, ownership lease, inbound state store, and grant records.
- **Source correlation:** a new contract and server projection should contain only the minimum identifiers needed to route a response and prove freshness. Store IDs and hashes, never raw token or unredacted prompt text.
- **Run metadata:** add an optional Telegram source attribution to the run/task record through the existing task creation seam, so Telegram is an origin label rather than a second run engine.
- **Outbound rendering:** reuse the existing Telegram renderer, redaction, HTML escaping, link sizing, and shared send budget. No direct `sendMessage` call may bypass the dispatcher.
- **Authorization:** reuse `authorize`, `grantFresh`, `beforeEffect`, and current account/provider gates. The source correlation is an additional freshness check, not a replacement.
- **Recovery:** claimed source effects recover to uncertain using the existing journal rules. Delivery retries may resume, but task effects never replay solely because a Telegram send failed.

## API and route shape

All new request and response shapes belong in `packages/contract` and are inferred with Zod. Routes remain chained under `/api/v1` with project aliases and middleware validation.

Stage 1 may add only orchestration endpoints if existing routes cannot express the wizard:

- begin/connect bot;
- discover or select a chat;
- test token/chat;
- set permissions and activate;
- reset or recover an orphan.

Stage 2 requires a route or internal service seam for creating a Telegram-originated task and for reading its source status. The route must preserve current scope, hosted/flag gates, error schema, and HTTP status behavior.

## Rollout and compatibility

- Ship Stage 1 behind the existing explicit Telegram/inbound activation controls.
- Ship Stage 2 disabled until a receiver has the task-control permission and a verified grant.
- Existing outbound receivers continue to deliver without the wizard.
- Existing pairings remain valid; migration is additive and must not rotate grants unless the operator explicitly changes pairing or permissions.
- Every new state has an explicit transition table for activation, disable, conflict, blocked, vault failure, restart, revoke, and reset.

## Acceptance criteria

### Stage 1

- A new user can connect a bot and private chat without manually entering a chat ID.
- Invalid, revoked, conflicted, blocked, and transient credentials show distinct recovery guidance.
- No token is rendered after submission or written outside the vault.
- Notifications-only mode never starts inbound task control.
- Reset and orphan recovery remain reachable with zero receivers.
- Existing outbound webhook tests and non-Telegram formats remain green.

### Stage 2

- An authorized Telegram command creates exactly one Cezar task and records its source.
- The source chat receives acknowledgement and final result messages through the shared limiter.
- Questions, confirmation, continue, and cancel work only for the original authorized user/chat and fresh run state.
- Revocation, disable, permission changes, account changes, provider changes, restart, conflict, and delivery failure are fail-closed and auditable.
- Telegram output is escaped, redacted, size-bounded, and never leaks credentials or hidden paths.
- Replaying an update or retrying a delivery cannot execute the task twice.
- The full suite, typecheck, build/package checks, browser setup flow, and a controlled live Telegram smoke test pass.

## Open decisions for implementation

- Whether progress uses one editable Telegram message or a bounded sequence of messages. Default proposal: one acknowledgement plus edited status message where supported, with a final message; fall back to bounded follow-ups when editing is unreliable.
- Whether Telegram-originated tasks use the current project/account by default or require an explicit project alias. Default proposal: the receiver's project and the paired user's current saved account, subject to the same provider gate.
- Whether a task response includes a cockpit link by default. Default proposal: include it for long output, questions, and errors; omit it from short confirmations.

