# Telegram setup wizard and task replies design

This is the canonical design for the Telegram integration. Telegram is configured
from Settings → **External integrations** → **Connect Telegram**. The wizard owns
bot connection, notifications and optional task control; Webhooks is reserved for
Slack, Discord and custom receivers.

The wizard requires dedicated-bot consent before polling, discovers the chat from
a private **Start**, and applies the additional visibility and comparison checks
for groups. Setup sessions are transient and expire on restart. Task-control
permissions are explicit: `respond` is the base, and `start` (`/task`), `cancel` and
`continue` are separate opt-ins, off by default.

## Intent

Make Telegram useful without requiring the operator to understand webhook receiver fields, chat IDs, pairing revisions, or permission generations. The existing Telegram receiver and pairing implementation remains the source of truth; the new work adds a guided setup flow and then completes the round trip for tasks started from Telegram.

The user should be able to connect a bot, connect a private chat, choose what that person may do, and activate the connection from one guided flow. In the second stage, a task started from that Telegram chat should produce progress and final responses in the same chat, while retaining the existing Cezar account, provider, authorization, redaction, and delivery guarantees.

## Goals

- Provide a setup wizard inside the existing Telegram settings surface.
- Configure notifications and, when inbound is enabled, Telegram task control in one wizard.
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
- Sending unredacted prompts, local private paths (home, user, temp, cezar-home and project roots, drive-letter, UNC and `file://` paths), secrets, or raw provider output to Telegram.

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

1. Settings → **External integrations** offers one **Connect Telegram** entry point. The operator enters a bot token, confirms it is dedicated to this project, and the wizard does not start polling before explicit activation. Webhooks remains the setup surface for Slack, Discord and custom receivers, not Telegram.
2. The wizard offers two links built from the same setup code: **Private chat with the bot** (`?start=`) and **Add to a group** (`?startgroup=`, forum groups unsupported). A private **Start** discovers the chat and is the single proof of the person's identity; a group Start discovers the group, and the wizard names it.
3. For a group, the operator confirms that all members can read project messages before notifications activate; for task control the candidate compares the wizard's code with the code sent privately by the bot.
4. The operator reviews the shell/cost warning and may grant **Start tasks** (gates `/task`; private chats only), **Cancel tasks** and **Continue tasks (may incur costs)**; all are off by default and replying is always allowed. With only `CEZ_WEBHOOKS=1` the card and wizard set up notifications and show task control disabled with "needs `CEZ_CHAT_INBOUND=1`"; hosted and webhooks-off cockpits are explained before the wizard opens. Private task control can be enabled during the same flow; group notifications are activated first and task control then requires a private Start and comparison code.
5. Completion shows health, the current grant and recovery actions. Errors map to actionable states: invalid token, bot conflict, blocked bot, chat not found, pairing expired, vault unavailable, damaged state, or insufficient permission.

A first token-led setup binds the bot to the project when its link is created. If that setup is cancelled, expires, fails, or is cut short by a restart before any chat is bound, the bot is released again (its state and `binding.json` removed), so it is not listed and another project can connect it. A setup on a bot that already serves a chat never releases it. A notifications-only re-run on a chat whose people are already approved keeps their task control.

Group pairing remains an explicit advanced path with a privacy warning and membership confirmation. It is not silently selected by the private-chat wizard.

### Managing chats in the Telegram tab

- **Chats** lists every `telegram.v1` receiver, bound to a bot or not: name, private chat or group, notification state and last test, with **Send test**, **Pause**/**Resume** (or **Activate** after a passing test), **Options** and **Remove** (confirmed). These use the existing `/webhooks` receiver routes; no token is re-entered.
- **Options** edits Message content (Minimal/Standard), "Include an excerpt of the agent's last message" (Standard only) and the notification delay through `PATCH /webhooks/:id` with the receiver's full settings. These edits keep the chat active and its task control bound. Minimal content suspends task control for that chat, and the panel says so.
- A second receiver for the same chat is marked **Duplicate** (it doubles every notification) and offers Remove. The one kept is the one with task control, else the one bound to a bot, else the oldest; a duplicate never gets task control of its own.
- **People and permissions** shows task control per chat. A chat without an approved person reads "Notifications only" with an **Enable task control** button; the approval form opens only from that button, never permanently. A bound chat does not ask for bot dedication again (it was given when the bot was connected). A paired group offers **Approve another member**; a private chat whose pairing went stale offers **Replace pairing**. Approval and each person's row offer **Start tasks**, **Cancel tasks** and **Continue tasks (may incur costs)**, all off by default; groups never offer Start tasks.
- A suspended binding names its cause: a bot removed from the group is fixed by adding it back and **Enable replies**; a private chat whose person blocked the bot is fixed once they unblock it, then **Enable replies**; a migrated group by removing the chat and connecting the group again with **Add a chat**. A paused chat suspends its replies too, and reads as paused, not as a fault.
- With `CEZ_WEBHOOKS=1` alone the chats stay manageable and the tab explains that task control needs `CEZ_CHAT_INBOUND=1`.
- Reset access and Disconnect bot confirm with a danger button. Reset keeps notifications; Disconnect stops them. Bot cards show `@username` when the server knows it.

### Availability, idempotent activation and removal

- **Two levels.** Notifications and the token-led setup that discovers their chat need `CEZ_WEBHOOKS=1` only; task control (approving people, replies, commands, `/task`) also needs `CEZ_CHAT_INBOUND=1`. With the inbound flag off the bot polls only while a setup waits for its `/start`, and no grant authorizes anything. Task-control activation, approving a person on an existing receiver and editing or revoking people answer `503 flag_off`. `GET …/telegram` keeps `available`/`reason` for task control and adds `notifications` and `taskControl` (each `{ available, reason? }`) so the cockpit can gate each. The setup status names a discovered group (`candidate.chatTitle`), the state names each bot (`username`) and why Telegram suspended a receiver (`suspendedReason`).
- **Idempotent activation.** A token-led activation creates (or reuses) the receiver, waits for its test delivery's real result, then binds it. A receiver it made is deleted with its vault entry when that test fails; once made, a retry after a later failure (a lost approval, a revision conflict) reuses it. A setup for a chat this bot already sends to reuses that receiver and its binding instead of adding a second one; a new token for the same bot and chat replaces the stored token and is retested.
- **Group consent.** A token-led group activation needs `groupVisibilityAccepted`, a plain (non-forum) group and the bot a member of it, checked on the server before any receiver exists — the same checks an existing group receiver gets.
- **Per-chat options.** The Telegram tab edits a chat's message content (Minimal/Standard), agent-excerpt consent and delay through the existing `/webhooks/:id` routes, no token needed. Those edits keep the receiver active and its delivery revision, so task control stays bound; a chat, token or format change still needs a fresh test.
- **Reset and Disconnect.** Reset removes every approved person and keeps the bot's notifications. Disconnect removes the bot from the project: its people, its state and binding, and every receiver that sends through it (deleted, tokens included), so a disconnected bot never keeps sending. Receivers go first, so a failure leaves a connected, resettable bot.

### Stage 2: Telegram-originated tasks

1. A paired user sends an accepted command or replies to a Cezar message in the authorized private chat. Commands must use the existing parser and group addressing rules.
2. The service creates a source record containing project, receiver, grant generation, Telegram chat ID, user ID, source message ID, episode/request ID, and the Cezar run ID once created. The source record is bounded and durable enough to recover an uncertain send without repeating the task effect.
3. Telegram receives an immediate acknowledgement such as **Accepted** or **Needs confirmation**. The acknowledgement is sent through the shared Telegram budget and is not a second task execution.
4. Progress updates are coalesced and bounded. The default is one status message per meaningful state transition, with edits or a compact follow-up when Telegram limits or chat readability make edits unsuitable.
5. A task-control user whose grant permits replies and whose task is asking for input receives the existing question/options format and a Reply instruction tied to the source message. The response parser accepts a fresh Reply, an ordinary private-chat message in the current task context, or an approved command from the same authorized user/chat; the wizard grants task control rather than a read-only pairing.
6. Final states map to concise Telegram messages: completed, cancelled, failed, expired, unauthorized, or unavailable. Long output is redacted, escaped, truncated, and linked to the cockpit when appropriate.
7. Continue, cancel, and confirmation actions re-check the current grant, receiver generation, account, provider, and run state immediately before applying the effect. A stale or revoked source receives an explanatory refusal and cannot mutate the run. Delivering the source's own notices only needs the binding enabled and the requester still holding that grant: a permission edit or Disable/Enable rotates generations but keeps those notices with the bot, and their correlations carry the binding's current generation. Disable/Enable and a blocked private chat drop that chat's question correlations but keep its delivery receipts (`deliveryReceipt` in `telegram/state.ts`), so no notice is sent twice, before or after a restart; an explicit Reply routes only through a correlation of the current enable generation, so a Reply to a notice from before Disable gets "cannot match".
8. If Telegram delivery fails after the task effect is durably claimed, the task is not rerun. The source record and audit activity expose the delivery failure for retry or cockpit inspection.

## Data and service boundaries

- **Wizard state:** transient client state only; durable bot credentials and pairing state remain in the existing vault, endpoint registry, ownership lease, inbound state store, and grant records.
- **Source correlation:** a new contract and server projection should contain only the minimum identifiers needed to route a response and prove freshness. Store IDs and hashes, never raw token or unredacted prompt text.
- **Run metadata:** add an optional Telegram source attribution to the run/task record through the existing task creation seam, so Telegram is an origin label rather than a second run engine.
- **Outbound rendering:** reuse the existing Telegram renderer, redaction, HTML escaping, link sizing, and shared send budget. No direct `sendMessage` call may bypass the dispatcher.
- **Authorization:** reuse `authorize`, `grantFresh`, `beforeEffect`, and current account/provider gates. The source correlation is an additional freshness check, not a replacement.
- **Source chat ownership:** a Telegram-started task's source chat is owned by the bot runtime only while it will deliver (`ownsSourceDelivery`); otherwise ordinary webhook admission notifies it. A final can repeat once after such a gap.
- **Private path scrub:** Telegram text is scrubbed by `scrubTelegramText` (private roots only; a root also ends at a quote or trailing punctuation; one-character roots such as `/` are ignored). Webhook payloads keep `scrubWebhookText`.
- **Recovery:** claimed source effects recover to uncertain using the existing journal rules. Delivery retries may resume, but task effects never replay solely because a Telegram send failed.

## API and route shape

All new request and response shapes belong in `packages/contract` and are inferred with Zod. Routes remain chained under `/api/v1` with project aliases and middleware validation.

Stage 1 adds only the guided-setup endpoints (`…/telegram/setup`, its status, activation and cancel) beside reset, disconnect and orphan recovery. The chat is discovered from the bot's own `/start`; the earlier `POST /webhooks/telegram/connect` chat lookup was removed before release.

Stage 2 requires a route or internal service seam for creating a Telegram-originated task and for reading its source status. The route must preserve current scope, hosted/flag gates, error schema, and HTTP status behavior.

## Runtime boundaries

- Ship Stage 1 notifications behind `CEZ_WEBHOOKS=1`, and its task control behind `CEZ_CHAT_INBOUND=1` as well.
- Ship Stage 2 disabled until a receiver has the task-control permission and a verified grant.
- Existing outbound receivers continue to deliver without the wizard.
- Every new state has an explicit transition table for activation, disable, conflict, blocked, vault failure, restart, revoke, and reset.

## Acceptance criteria

### Stage 1

- A new user can connect a bot and private chat without manually entering a chat ID.
- Invalid, revoked, conflicted, blocked, and transient credentials show distinct recovery guidance.
- No token is rendered after submission or written outside the vault.
- Polling and inbound task control never start before dedicated-bot consent and explicit wizard activation.
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

## Message behavior

- Progress: a bounded sequence of messages (acknowledgement, progress or question messages, one final message); no message editing.
- Project/account: the receiver's project and the saved provider; `/task` shows the project, workflow and provider in a preview and starts only on **Confirm** (private chat, two minutes, same person).
- Cockpit link: not added to short confirmations; a reply too long for one message ends with a note that the full reply is in the cockpit.

- The final message of a task started from Telegram (`done` or `review`) carries the agent's last message after `Agent:`, kept from its start, redacted and path-scrubbed, bounded to one Telegram message; a shortened reply names the cockpit. It goes only to the requester's private chat and needs no `includeAgentExcerpt` opt-in: the requester asked the question. A `waiting` notice without structured questions carries the same reply there, in place of the opt-in excerpt; group chats keep the opt-in excerpt.
- The completion line is `Repository:` (`Unchanged`, `Pull request opened`, `Changes accepted`), so the Git outcome is never read as the answer; `completed` and `unknown` have no line.
- `/status` never carries agent text, so a person with access cannot page through other tasks' output. `/status` without an ID shows the sender's own latest Telegram task.

### Private-chat task context

- In an approved private chat, ordinary text goes to the task of the person's latest interaction: the newest of a confirmed `/task`, an explicit address (`/reply X`, `/status X`, `/continue X` or a Reply to a notice, kept per person in the inbound state's optional `contexts`), a notice this chat received about a task the person started (progress, question or final), and a question notice of any task. A later cockpit question therefore wins over an older final, and a later final over an older question.
- What the text does depends on that task's state: waiting, it answers the current question; running or queued, it is delivered as a follow-up message (queued or deferred when the agent is busy) and acknowledged as such; terminal, it opens the Continue preview, which names the task by title and shows the text it will send. A Reply to a final or progress notice is the same follow-up; only a Reply to a question notice is pinned to that question. The separate `continue` permission and confirmation remain mandatory.
- Recognized commands always win over context (`/tasks`, `/status`, `/reply`, and the other bot commands). Groups never use implicit context routing; they require an addressed command or an explicit Telegram Reply.
- No "Task in progress" notice follows "Started task X" or "Continuing task X" directly; one is sent only after another notice of that turn, or for a task recovered after a crash, whose requester never heard it start.

### Groups

- The bot answers only commands addressed to it (`/tasks@bot`) and Replies to its own notices. Any other Reply is ignored without an answer, from members and strangers alike.
- A person without a grant who addresses the bot in a bound group is told to ask the cezar operator; nobody in a group is told to start pairing. Strangers in an unbound group hear nothing.
- Before acting on a group message or button, the bot re-checks the person's membership with `getChatMember` (cached for a minute). Someone who left or was removed is refused; when Telegram cannot answer, nothing is done. A person who rejoins passes the check again, so revoking a grant stays the way to end access.
- Group help names only addressed commands and `/status@bot <task>` with an ID: tasks cannot start in a group, so there is no latest own task there.
