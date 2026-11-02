# Telegram Router and Settings Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram one coherent External integrations tab and route inbound messages through an explicit command/reply/implicit-answer router.

**Architecture:** Add a small classifier/router seam before the existing Telegram conversation actions. Commands win over all task-answer paths; explicit Telegram replies use message correlation; ordinary private-chat text uses only the latest pending episode in that chat. Keep authorization, freshness and delivery in the existing conversation/action layer. Render Test frameworks first and Telegram second, with no separate Two-way Telegram toggle.

**Tech Stack:** TypeScript, Vitest, React 19, TanStack Query, existing Telegram conversation/runtime and settings components.

**Spec:** `docs/superpowers/specs/2026-11-02-telegram-conversation-router-design.md`

## Global Constraints

- Recognized slash commands are handled before task answers and never delivered to an agent task.
- Implicit answers are private-chat only and use the latest pending episode for that approved chat.
- Groups retain their existing explicit task-control and comparison safeguards; no implicit group replies.
- Keep `/reply` as an explicit fallback and preserve existing permissions, freshness, receipts and confirmation behavior.
- Telegram appears after Test frameworks in External integrations.

## Review Focus

- A command resembling ordinary text (`/tasks`, `/status`, `/reply`, `/task`, `/cancel`, `/continue`) must not reach task delivery — router tests.
- A plain answer in a private chat with several runs must select only the latest pending episode — conversation/router tests.
- A plain answer in a group or with no pending episode must not answer any task — router tests.
- A Reply to a question must retain explicit message correlation and beat implicit selection — router tests.
- Leaving/collapsing Telegram setup must not leave a second hidden setup entry or stale setup session — settings tests.

### Task 1: Telegram message router

**Files:**
- Create or modify: `packages/cezar/src/telegram/message-router.ts`
- Modify: `packages/cezar/src/telegram/conversation.ts`
- Test: `packages/cezar/src/telegram/message-router.test.ts` and existing conversation tests

**Interfaces:**
- Produces `classifyTelegramMessage(update, context): TelegramMessageRoute`, with route variants `command`, `explicit-reply`, `implicit-reply`, and `unhandled`.
- The route carries only the parsed command or task/episode correlation needed by the existing conversation handler; it does not bypass authorization or freshness checks.

- [ ] Write red tests for command precedence, explicit Reply precedence, latest pending private-chat answer, group exclusion, and no-pending fallback.
- [ ] Implement the classifier using existing command parsing, message Reply metadata, approved chat identity and pending-episode lookup seams.
- [ ] Route classified results through existing conversation actions without duplicating task mutation or delivery logic.
- [ ] Run focused Telegram conversation/router tests and the existing command, reply, runtime and dispatcher tests.
- [ ] Commit `feat: route Telegram answers by conversation context`.

### Task 2: Unified External integrations Telegram tab

**Files:**
- Modify: `packages/web/src/routes/settings/integrations-section.tsx`
- Modify: `packages/web/src/routes/settings/telegram-inbound.tsx`
- Modify: `packages/web/src/routes/settings/telegram-wizard.tsx`
- Test: `packages/web/src/routes/settings/integrations-section.test.tsx`, `telegram-inbound.test.tsx`, `telegram-wizard.test.tsx`

**Interfaces:**
- Consumes the existing unified `TelegramWizard` and `TelegramInboundPanel` APIs from Task 1-independent UI code.
- Produces an External integrations tab order of `test-frameworks` then `telegram`; Telegram renders setup and management content directly with no `Two-way Telegram` toggle.

- [ ] Write red UI tests for tab order, absence of `Two-way Telegram`, and removal of the stale wizard description.
- [ ] Move the existing Telegram section into the second tab and render management/diagnostics directly without the collapsible entry button.
- [ ] Replace stale explanatory copy while preserving explicit risk, diagnostics and revocation text where useful.
- [ ] Run the focused settings suite and web typecheck/build.
- [ ] Commit `feat: simplify Telegram integrations settings`.

### Task 3: Integrated verification and review

**Files:**
- Modify only tests/docs if verification reveals an exact mismatch.

- [ ] Run the complete Telegram/webhook/server focused suite, web and contract typechecks, web build and docs check.
- [ ] Run the Telegram browser e2e fixture with the External integrations route when the e2e dependency is available; record an environment blocker otherwise.
- [ ] Dispatch an independent review of the integrated branch focused on command precedence, private-chat implicit replies, group isolation and settings placement.
- [ ] Address review findings, rerun affected tests, and push the verified branch to the existing fork only after all checks pass.

