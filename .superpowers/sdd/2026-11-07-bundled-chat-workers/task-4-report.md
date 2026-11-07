# Task 4 report — bundled Discord worker

## Status

Implemented the Discord bundled-worker artifact and provider-local host boundary. The public
provider remains `discord`, the format remains `discord.v1`, and no receiver, grant, journal or
chat identity format was changed.

## Changes

- Added `packages/cezar/bundled-chat/discord/manifest.json` for the generated immutable catalog.
- Added the worker entrypoint at `packages/cezar/bundled-chat/discord/index.ts`. It accepts only
  generation/provider-scoped start/stop and bounded Discord operations, owns the Discord Gateway
  connection, emits validated event/health frames, and preserves Gateway reconnect and sequence
  cursor behavior by using the existing Discord Gateway implementation.
- Added `discordBundledOperationSchema` and `discordBundledContextSchema` plus
  `discordBundledTransport`, `encodeDiscordBundledOperation`, and
  `acceptDiscordBundledFrame` in `src/chat/providers/discord/bundled-adapter.ts`.
  Native-command payloads and interaction ACKs require an event ID; event acceptance precedes
  journal checkpointing; stale provider or generation frames are rejected.
- Added the optional `onReceiveCursor` hook to the Discord Gateway so worker event frames carry
  the latest Gateway sequence cursor without exposing Gateway objects to the host.
- Re-exported the bundled adapter facade through `server/discord-service.ts`; the existing
  compatibility transport remains available when no worker handle is supplied.
- Added focused boundary tests for operation validation, native-command payload validation,
  generation fencing, accept-before-checkpoint ordering, and checkpoint failure behavior.

## Verification

- `git diff --check` — passed.
- `timeout 300 npx tsc --noEmit -p packages/cezar/tsconfig.json` — blocked by the same broad,
  pre-existing contract/API drift (missing automation and chat-contract exports); diagnostics
  begin in `src/automations/*` and `src/chat/*`, not in the Discord additions.
- Focused Vitest command attempted:
  `timeout 300 npx vitest run packages/cezar/src/chat/providers/discord/bundled-adapter.test.ts packages/cezar/src/chat/providers/discord/gateway.test.ts packages/cezar/src/chat/providers/discord/native-commands.test.ts`
  — blocked during module initialization by pre-existing contract drift in this checkout:
  `chatIdentifierSchemas` is undefined in `src/chat/providers/discord/identity.ts` (the same
  missing chat-contract exports documented by Task 2). The standalone native-command suite passed
  before the two suites importing the broken contract initialized.

## Follow-up

Startup activation and runtime callback registration remain intentionally outside this task's
scope; the shared runtime/registry/startup task owns those changes. The worker boundary is ready
for that owner to supply a `BundledProviderHandle` and connect its `onFrame` callback to
`acceptDiscordBundledFrame`.
