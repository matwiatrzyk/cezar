# Task 3 report — bundled Slack worker

## Scope

Implemented the Slack bundled worker artifact while keeping the public provider alias
`slack`, wire format `slack.v1`, and existing Slack receiver/chat/message identity formats.

## Changes

- Added `packages/cezar/bundled-chat/slack/manifest.json` and `index.ts`.
- Added the provider-owned `bundled-adapter.ts` SDK adapter factory.
- The adapter delegates identify, discovery, send, button clearing, membership and
  credential validation to the existing Slack transport, and runs Socket Mode in the
  worker process.
- Socket envelopes are acknowledged immediately; normalized events are deduplicated,
  assigned bounded monotonically increasing receive sequences, and returned after the
  caller's cursor. Reconnect is bounded and old queue entries are capped.
- Worker disposal terminates the socket and prevents reconnects. Credentials are decoded
  using the existing persisted Slack credential schema; no credential is included in an
  event frame, error, or receipt.
- Added focused construction/credential-boundary tests.

## Verification

- `git diff --check` passes.
- TypeScript diagnostics for the new adapter are clean; the repository-wide typecheck
  remains blocked by pre-existing contract/API drift on this branch.
- The focused test file exercises construction without I/O and rejects invalid persisted
  credentials. Full Slack transport suites continue to cover normalization, immediate
  Socket Mode ACKs, reconnect, rotation, stale generation fences, and receiver identity.

## Follow-up

Host startup ownership and shared runtime registration remain intentionally outside this
task's Slack provider scope; the artifact is consumed by the bundled runtime/catalog work.
