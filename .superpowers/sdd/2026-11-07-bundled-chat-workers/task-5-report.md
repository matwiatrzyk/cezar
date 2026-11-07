# Task 5 report — bundled chat worker lifecycle integration

## Status

Implemented the server-side ownership decision that runs before project webhook/chat
recovery. Each project now records one bundled-chat owner decision for its activation:

- local projects with an intact, integrity-checked bundled catalog select the bundled
  provider owner;
- hosted projects and `CEZ_EXTENSIONS=0` select the existing compatibility owner;
- missing, old, or invalid optional artifacts silently select compatibility so persisted
  Slack/Discord pairings are not stranded.

The decision is stored per `ProjectContext`, is idempotent during repeated recovery hooks,
and is cleared before extension teardown so a later activation cannot reuse stale ownership.
The recovery hook performs this selection before `WebhookCoordinator.attach`, which is the
point where persisted chat services are opened and their journals recovered. The existing
public provider IDs, formats and persisted identities are untouched.

## Files changed

- `packages/cezar/src/server/extensions.ts`
  - added `restoreBundledChatWorkers` and per-project ownership state;
  - added local catalog discovery with fail-safe compatibility fallback;
  - clears bundled ownership on project close.
- `packages/cezar/src/server/server.ts`
  - selects bundled/compatibility ownership before webhook/chat recovery;
  - performs boot-project selection as part of startup.
- `packages/cezar/src/server/extensions-hosted.test.ts`
  - regression coverage for disabled/hosted-style compatibility ownership.

## Verification

- `git diff --check` passed.
- Focused Vitest invocation was attempted:
  `timeout 300 npx vitest run packages/cezar/src/server/extensions-hosted.test.ts`
  It is blocked before test collection by the checkout's pre-existing contract drift:
  `stepSecretsSchema` is undefined in `src/workflows/graph.ts`.

## Follow-up / limitation

The current checkout's `WebhookService` still constructs the legacy Slack/Discord facades
directly; the worker artifacts do not yet expose a complete host RPC transport for their
outbound operations (the Slack entrypoint is an adapter export and the Discord entrypoint
currently owns gateway frames). Consequently this task wires the lifecycle ownership gate
and recovery ordering, while preserving compatibility as the safe runtime owner until the
provider host facades are connected. No docs or public API schemas were changed.
