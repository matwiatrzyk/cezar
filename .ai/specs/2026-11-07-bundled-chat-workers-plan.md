# Bundled Slack and Discord Workers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the shipped Slack and Discord adapters in isolated bundled workers while preserving their public IDs, persisted receiver/grant/journal state, setup behavior and zero-config fallback.

**Architecture:** Add an immutable bundled-provider catalog and artifact loader on top of the existing extension host. Workers use the existing bounded RPC and chat adapter contract; a host compatibility facade owns credentials, durable receive acceptance, authorization, rotation and Gateway/native-command control. Stable `slack` and `discord` aliases remain reserved and resolve to exactly one worker or one compatibility adapter per project.

**Tech Stack:** TypeScript ESM, Node 20+, Zod 4, existing extension worker/RPC host, Slack Socket Mode/Web API adapter, Discord Gateway adapter, Vitest, npm package/build checks.

**Spec:** `.ai/specs/2026-11-07-bundled-chat-workers-design.md`

## Global Constraints

- Ship workers inside the Cezar package; startup performs no npm install or network download.
- Keep public provider IDs exactly `slack` and `discord`; formats remain `slack.v1` and `discord.v1`.
- Existing receiver IDs, grants, journals, setup routes, task authorization and UI descriptors remain readable without migration or re-pairing.
- External extension providers remain qualified as `extensionId/localId`; external registration of reserved IDs/formats is rejected.
- `CEZ_EXTENSIONS=0` disables bundled worker activation and uses the existing host adapter compatibility path without duplicate consumers.
- Hosted Cezar never starts bundled workers; local-only restrictions remain enforced.
- The host owns credentials, secrets, journals, authorization and task effects; workers own platform sockets only.
- Every wire effect checks worker generation and abort state immediately before execution.
- Tests use simulated Slack/Discord platforms and no real credentials or network calls.

## Review Focus

- Missing or tampered packaged artifacts must fail closed per provider and select one compatibility/error owner; test catalog integrity and no duplicate connection.
- Worker crash/restart must replay safely from the host journal without duplicate task creation; test stable event IDs, cursors and ACK idempotency.
- `CEZ_EXTENSIONS=0` and hosted mode must not start workers or strand existing configured integrations; test fallback ownership and teardown.
- Existing persisted `slack`/`discord` receiver, grant and journal records must resolve to the worker path without rewriting IDs; test restart and migration-free lookup.
- Slack rotation and Discord Gateway/native interactions must not leak host objects or bypass generation fences; test bounded RPC, abort and stale-generation rejection.

### Task 1: Bundled catalog, manifest and package artifact contract

**Files:**
- Create: `packages/cezar/src/extensions/bundled-catalog.ts`
- Create: `packages/cezar/src/extensions/bundled-catalog.test.ts`
- Modify: `packages/cezar/src/extensions/manager.ts`
- Modify: `packages/cezar/src/extensions/installer.ts`
- Modify: `packages/cezar/src/release/manifests.ts`, `packages/cezar/scripts/check-pack.mjs`, package build scripts
- Test: `packages/cezar/test/e2e/release*.test.ts`

**Interfaces:**
- Produce `bundledProviderManifestSchema` with `{ id: 'slack'|'discord', version, entry, integrity, format }`.
- Produce `loadBundledProviderCatalog(packageRoot): Promise<readonly BundledProviderManifest[]>`.
- Produce `reservedBundledProviderIds(): readonly ['slack','discord']` and collision validation used by the external registry.

- [ ] Write failing tests for exact catalog parsing, path containment, integrity mismatch, missing artifact, reserved-ID collision, and package tarball inclusion.
- [ ] Run `timeout 300 npx vitest run packages/cezar/src/extensions/bundled-catalog.test.ts`; confirm failure before implementation.
- [ ] Implement the catalog loader and build/check-pack copy contract. Catalog entries must resolve only inside `dist/bundled-chat/<id>/`; never use npm resolution.
- [ ] Add manager-level catalog discovery without activation; verify external `extensionId/localId` providers cannot claim `slack`, `discord`, `slack.v1` or `discord.v1`.
- [ ] Run focused catalog/release tests and `npm run check:pack`; commit `feat: add bundled provider artifact catalog`.

### Task 2: Bundled lifecycle, alias registration and durable receive boundary

**Files:**
- Create: `packages/cezar/src/extensions/bundled-runtime.ts`
- Create: `packages/cezar/src/extensions/bundled-runtime.test.ts`
- Modify: `packages/cezar/src/extensions/protocol.ts`, `packages/cezar/src/extensions/rpc.ts`, `packages/cezar/src/extensions/host.ts`
- Modify: `packages/cezar/src/extensions/chat-bridge.ts`, `packages/cezar/src/chat/registry.ts`, `packages/cezar/src/chat/inbox.ts`
- Test: `packages/cezar/src/extensions/chat-bridge.test.ts`, `packages/cezar/src/chat/recovery.test.ts`, `packages/cezar/src/chat/inbox.test.ts`

**Interfaces:**
- Produce `startBundledProvider(manifest, context): Promise<BundledProviderHandle>` and `BundledProviderHandle.stop(): Promise<void>`.
- Produce `registerBundledChatProvider(scope, descriptor, transport): Promise<dispose>` that permits only reserved stable IDs and rejects duplicates.
- Produce `bundledChatFrameSchema` for `{type:'event'|'health', providerId, generation, cursor?, event?, state?}`.

- [ ] Write failing tests for startup ordering, one owner per provider, stale-generation rejection, abort fencing, crash state, replay of an already accepted event, stable-ID lookup, and clean stop before manager close.
- [ ] Run the focused tests and confirm failures.
- [ ] Implement host-owned journal acceptance: accept event, then checkpoint cursor; stable provider/event IDs suppress replay before task dispatch. Keep existing in-memory dedupe only as an optimization.
- [ ] Implement per-provider fallback ownership for `CEZ_EXTENSIONS=0`, hosted mode and activation failure; never run worker and compatibility adapter concurrently.
- [ ] Run extension/chat recovery tests; commit `feat: add bundled worker lifecycle and durable chat boundary`.

### Task 3: Slack bundled worker

**Files:**
- Create: `packages/cezar/bundled-chat/slack/manifest.json`, `packages/cezar/bundled-chat/slack/index.ts`
- Create: `packages/cezar/src/chat/providers/slack/bundled-adapter.ts`
- Modify: `packages/cezar/src/chat/providers/slack/connection.ts`, `packages/cezar/src/chat/providers/slack/client.ts`, `packages/cezar/src/server/slack-service.ts`
- Test: `packages/cezar/src/chat/providers/slack/bundled-adapter.test.ts`, existing Slack conformance/rotation tests

**Interfaces:**
- Worker entry exports the existing SDK adapter factory for `identify`, `inspect`, `send`, `clearButtons`, `acknowledge`, `isMember`, `receive`, and bounded `rotate`.
- Host facade preserves `SlackInbound` and accepts the existing credential encoding and receiver IDs.

- [ ] Write failing simulated-platform tests for worker identity/discovery/send/receive, Socket Mode reconnect cursor, token rotation, ACK idempotency, stale generation and crash fallback.
- [ ] Run the Slack focused tests and confirm failures.
- [ ] Move/copy only the provider-owned transport logic into the bundled entry; replace in-process startup with the bundled runtime path while preserving compatibility fallback.
- [ ] Verify old Slack receiver/grant/journal fixtures resolve without rewriting and no duplicate worker/fallback connection exists.
- [ ] Run all Slack suites and package smoke; commit `feat: run Slack through bundled worker`.

### Task 4: Discord bundled worker

**Files:**
- Create: `packages/cezar/bundled-chat/discord/manifest.json`, `packages/cezar/bundled-chat/discord/index.ts`
- Create: `packages/cezar/src/chat/providers/discord/bundled-adapter.ts`
- Modify: `packages/cezar/src/chat/providers/discord/gateway.ts`, `packages/cezar/src/chat/providers/discord/index.ts`, `packages/cezar/src/server/discord-service.ts`
- Test: `packages/cezar/src/chat/providers/discord/bundled-adapter.test.ts`, existing Discord gateway/native interaction tests

**Interfaces:**
- Worker entry exports adapter operations plus bounded `gatewayConnect`, `gatewayReceive`, `interactionAck` and `nativeCommand` operations through internal frames.
- Host facade preserves Discord snowflake/destination IDs, receiver/grant/journal records and native task controls.

- [ ] Write failing simulated-Gateway tests for reconnect/sequence cursor, duplicate event replay, interaction ACK idempotency, native command payload validation, stale generation and crash fallback.
- [ ] Run Discord focused tests and confirm failures.
- [ ] Move/copy provider-owned Gateway and interaction logic into the bundled entry; keep host authorization and durable acceptance in the facade.
- [ ] Verify existing Discord records and setup routes resolve unchanged and only one Gateway owner exists.
- [ ] Run all Discord suites and package smoke; commit `feat: run Discord through bundled worker`.

### Task 5: Startup integration, opt-out/fallback and UI compatibility

**Files:**
- Modify: `packages/cezar/src/server/extensions.ts`, `packages/cezar/src/server/project-context.ts`, `packages/cezar/src/server/server.ts`
- Modify: `packages/cezar/src/chat/recovery.ts`, `packages/cezar/src/chat/service.ts`, `packages/web/src/routes/settings/integrations-section.tsx`
- Test: startup/recovery/service lifecycle tests and web integration tests

**Interfaces:**
- `restoreProjectExtensions` starts bundled providers before chat recovery only in local mode and only once per project.
- `stopProjectExtensions` stops receive connections before workers and compatibility adapters.

- [ ] Write failing tests for startup ordering, hosted refusal, `CEZ_EXTENSIONS=0` fallback, one-provider activation failure, restart without re-pairing and UI descriptor stability.
- [ ] Run focused server/web tests and confirm failures.
- [ ] Wire the runtime into project lifecycle with per-provider state and diagnostics; do not change HTTP route IDs or persisted provider schemas.
- [ ] Run service/recovery/web tests; commit `feat: integrate bundled workers into project lifecycle`.

### Task 6: Full packaging, documentation and final verification

**Files:**
- Modify: `docs/extensions.md`, `docs/authoring-extensions.md`, `docs/adding-chat-provider.md`, `docs/reference.md`
- Modify: `packages/cezar/test/e2e/release.test.ts`, `packages/cezar/src/extensions/package.test.ts`
- Test: full extension/chat suites, package smoke and repository validation

- [ ] Add package smoke proving a clean Cezar tarball contains both workers and starts them without workspace dependencies.
- [ ] Document worker ownership, fallback, stable IDs, crash behavior, `CEZ_EXTENSIONS=0`, and the non-sandbox limitation.
- [ ] Run `timeout 300 npm run typecheck`, `timeout 600 npm run build`, `timeout 300 npm run check:pack`, `timeout 600 npm test`, SDK tests/pack smoke, and focused e2e simulations.
- [ ] Inspect `git diff --check`, process list and package contents; commit `docs: document bundled chat workers`.

## Execution order

Tasks 1 and 2 are sequential. Tasks 3 and 4 are disjoint provider implementations and may run
in parallel after Task 2. Task 5 waits for both. Task 6 is last. Each task must pass its focused
tests before its commit; after every merge, rerun the relevant conformance suite.
