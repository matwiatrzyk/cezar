# Telegram unified integration and message router

## Intent

Telegram should be one coherent integration. Users configure it from one
External integrations tab, and messages in an approved private chat should
naturally stay in the context of the task that is waiting for an answer.

## Goals

- Put `Test frameworks` first and `Telegram` second in External integrations.
- Remove the separate `Two-way Telegram` entry point. The unified Telegram
  setup owns notifications, task control, diagnostics and revocation.
- Remove the stale wizard description that implies a second setup below it.
- Route inbound Telegram messages in a dedicated layer:
  1. recognized slash commands are handled as commands and never delivered to
     an agent task;
  2. a Telegram Reply to a question uses that message's task correlation;
  3. ordinary text in the same approved private chat answers its latest
     pending question when no command or explicit Reply correlation applies.
- Preserve existing permission checks, freshness checks, delivery receipts,
  group restrictions and command behavior.

## Non-goals

- No new Telegram commands or changes to command syntax.
- No implicit task selection for groups; groups continue to require the
  existing explicit comparison and visibility safeguards.
- No change to task creation confirmation or to `/reply` as an explicit
  fallback.
- No backward compatibility for unpublished Telegram UI or persisted setup
  shapes.

## Approach

The router is a small pure decision seam in front of the conversation handler.
It classifies an update as `command`, `explicit-reply`, `implicit-reply`, or
`unhandled`. The conversation layer remains responsible for authorization,
task lookup, freshness and user-facing response delivery. This keeps command
parsing from accidentally becoming agent input and makes the precedence
visible in tests.

Precedence is command first, explicit Telegram Reply second, and ordinary
private-chat text last. Implicit replies use only the current approved private
chat's latest pending episode; they never search other chats or completed
tasks. If no pending episode exists, the message receives the existing
non-task help response rather than entering an agent.

The Telegram settings page renders `Tabs` with `test-frameworks` first and
`telegram` second. The Telegram tab keeps the unified setup button and renders
the existing management/diagnostics content directly, without a collapsible
Two-way Telegram button.

## Acceptance checks

- `/tasks` and every existing slash command do not call task reply delivery.
- Replying to a question reaches that question's task.
- Plain text in the same private chat reaches the latest pending question.
- Plain text without a pending question does not reach any task.
- Group plain text remains excluded from implicit task replies.
- Existing command, Reply, permission and stale-message tests remain green.
- External integrations renders Test frameworks before Telegram.
