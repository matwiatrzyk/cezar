# Task 2 report — bundled lifecycle, alias registration and durable receive boundary

## Status

Implemented the shared bundled-worker boundary without adding Slack or Discord provider
adapters, package artifacts, or startup wiring.

### Changes

- Added `bundledChatFrameSchema` and `BundledChatFrame` in `extensions/protocol.ts`.
  Event frames require an opaque event payload; health frames require a known chat health
  state. Frames are strict and carry provider ID plus generation.
- Added `startBundledProvider` and `BundledProviderHandle` in `extensions/bundled-runtime.ts`.
  The runtime launches the immutable catalog entry in a child Node process, sends a bounded
  start frame, validates newline-delimited frames, fences stale generations, reports crashes,
  and performs an orderly stop with a bounded termination fallback.
- Added `acceptBundledFrame`, the shared generation fence used before dispatching worker
  frames to host code.
- Added `registerBundledChatProvider` in `chat/registry.ts`. It accepts only the stable
  `slack`/`discord` aliases and their matching `.v1` formats, enforces one registration per
  project, emits registry change notifications, and disposes atomically. Scoped registrations
  take precedence over the compatibility catalog during lookup.
- Added focused boundary tests for frame validation, stable alias ownership/disposal, and
  stale-generation rejection.

## Verification

- `git diff --check` — passed.
- `timeout 300 npx vitest run packages/cezar/src/extensions/bundled-runtime.test.ts` —
  blocked during module initialization by the checkout's pre-existing contract drift:
  `chatFailureSchema` is undefined in `extensions/protocol.ts`.
- Focused extension/chat run was also blocked by the same checkout drift, including missing
  chat schemas such as `chatEventSchema`, `chatIdentifierSchemas`, and `chatReceiptSchema`.
- `npx tsc -p packages/cezar/tsconfig.json --noEmit` — blocked by the same broad, pre-existing
  contract/API mismatch in automation and chat modules. No diagnostics pointed at the new
  bundled runtime or registry changes before the existing failures.

## Follow-up

Task 3/4 provider workers should use the start/stop frames and emit only the strict bundled
event/health frames. Task 5 should connect `onFrame` to `ChatInbox.accept` and preserve the
existing accept-then-checkpoint ordering; this task intentionally does not add project startup
wiring or compatibility-owner selection.
