# Bundled Telegram, Slack and Discord workers

## Intent

Move the first-party Telegram, Slack and Discord adapters into the same isolated Node-worker execution
model used by external chat extensions, while preserving the zero-config behavior and every
persisted provider identity already in use.

## Goals

- Ship Telegram, Slack and Discord worker artifacts inside the Cezar package; startup performs no npm
  install or network download for them.
- Run each enabled provider in an isolated worker process with the existing bounded RPC,
  lifecycle timeout, generation fencing and redaction rules.
- Keep `telegram`, `slack` and `discord` as the public provider IDs, their `.v1` formats, credential shapes,
  receiver IDs, grants, journals, setup routes and UI descriptors.
- Preserve Slack token rotation and Discord Gateway/native command behavior through explicit
  host services exposed as narrow worker RPC operations.
- Keep external extension providers project-scoped as `extensionId/localId`; bundled aliases are
  the only exception and are reserved by the host.

## Non-goals

- No npm publishing, marketplace, signature verification or sandboxing in this migration.
- No automatic conversion of existing state files or re-pairing.
- No change to permissions, person approval, task authorization, rate limits or durable inbox
  semantics.
- No replacement of the existing extension worker protocol with provider-specific IPC.

## Constraints

- Local-only behavior remains unchanged; hosted Cezar refuses extension workers.
- `CEZ_EXTENSIONS=0` disables worker activation and falls back to the existing host adapter
  compatibility path, so the opt-out cannot remove already-configured integrations.
- Worker code never receives the Cezar process, vault, project filesystem or raw host objects.
- A worker crash marks the provider unavailable and must not create duplicate inbound events or
  tasks after restart.
- A provider update is atomic and keeps the previous bundled artifact available until the new
  worker passes activation.

## Architecture

The package build produces three immutable bundled artifacts under the service distribution. A
`BundledProviderCatalog` maps the reserved public IDs (`telegram`, `slack`, `discord`) to manifests, worker
entrypoints, descriptor metadata and a compatibility adapter. `ExtensionManager` activates these
artifacts before chat recovery, but registers them through a dedicated bundled registration path
that permits the stable IDs and rejects collisions with external providers.

The catalog is a checked-in, generated-at-build-time manifest at
`dist/bundled-chat/catalog.json`. Each entry has `{ id, version, entry, integrity, format }`, where
`id` is exactly `telegram`, `slack` or `discord`, `format` is `<id>.v1`, and `entry` is relative to the Cezar
package. The package build copies the worker JavaScript and its production dependencies into
`dist/bundled-chat/<id>/`; `check:pack` rejects a missing entry, path escape, or integrity mismatch.
The host never resolves these artifacts through npm.

The worker uses the existing SDK chat adapter contract. The host-side bridge remains responsible
for credentials, secret rotation, receive journaling, durable acceptance and task authorization.
Slack-specific operations are limited to token refresh/exchange and Socket Mode receive/send;
Discord-specific operations cover Gateway lifecycle, interaction acknowledgement and native
command payloads. Each operation has a Zod schema and an abort/generation check immediately
before the wire effect.

The host keeps a compatibility mode for `CEZ_EXTENSIONS=0` and for an activation failure. This
mode uses the existing in-process adapters and preserves the current user-visible behavior; it
is observable in diagnostics but never silently changes persisted identities.

Startup ordering is: construct the project extension manager, validate/load the bundled catalog,
start each enabled bundled worker, register exactly one provider owner, then restore chat
receivers and run receive recovery. Shutdown stops receive connections first, waits for pending
wire calls to settle or abort, stops bundled workers, and only then closes the extension manager.
If one worker fails activation, only that provider enters compatibility mode; the other bundled
worker remains isolated. A failed worker is not started alongside its fallback, and recovery never
switches owners while a receive connection is active.

The existing host-owned receive journal is the durable idempotency boundary. Every worker receive
batch carries a monotonically ordered provider cursor plus a stable event ID; the host calls
`accept(event)` before checkpointing the cursor. On reconnect the worker asks for the journal
cursor and may replay the last batch; the host drops an already accepted event by provider/event
ID before task dispatch. Slack's in-memory seen window and Discord's Gateway sequence are only
performance hints, never durability. Interaction/native-command ACKs carry the original event ID
as an idempotency key; the host acknowledges after durable acceptance and a retried ACK is safe.

Bundled RPC remains internal and Zod-validated. It uses the existing request/response frames plus
provider frames `{ type: 'event' | 'health', providerId, generation, cursor?, event?, state? }`.
The worker owns platform sockets; the host owns credentials, journals, authorization and task
effects. `generation` and `AbortSignal` are checked before every wire effect. Slack rotation is
an explicit bounded `rotate` operation; Discord Gateway connect, reconnect, interaction ACK and
native-command payloads are explicit bounded operations, never raw host objects or callbacks.

External extension registration remains rejected for the reserved IDs and for the `slack.v1` or
`discord.v1` formats. A persisted record is resolved by public provider ID first, then by the
worker owner; no receiver, grant, journal or history migration is performed.

## Migration sequence

1. Add bundled manifest/artifact discovery and reserved-ID registration tests without changing
   the current adapters.
2. Add worker-compatible Telegram, Slack and Discord adapter entrypoints and conformance tests against the
   existing provider suites.
3. Add host RPC facades for rotation, Gateway/native interactions and receive checkpoints; run
   the worker path behind a local-only activation gate while compatibility remains available.
4. Activate bundled workers before chat recovery, test restart/crash/reconnect and verify old
   receiver/grant/journal records resolve unchanged.
5. Make the worker path the default, retain compatibility fallback for opt-out/activation
   failure, update packaging/docs, and run the full validation suite.

## Acceptance criteria

- A clean packaged Cezar starts Telegram, Slack and Discord workers without installing packages.
- Existing Telegram, Slack and Discord pairings continue to receive, send, rotate credentials and handle
  native interactions after restart without re-pairing.
- Killing any worker stops only that provider, recovery does not duplicate accepted events,
  and disabling the provider fences in-flight wire calls.
- `CEZ_EXTENSIONS=0`, missing/tampered artifacts, activation failure and external-ID collisions
  select the documented compatibility/error path without starting duplicate consumers.
- Extension and chat conformance suites, typecheck, build, package checks and full `npm test`
  pass with no real credentials or network calls.

## Approaches considered

- Keep all adapters in-process: safest short-term, but does not deliver the requested worker
  isolation.
- Worker only for outbound sends: smaller migration, but inbound Gateway/rotation failures still
  crash or block the host path.
- Full bundled worker with stable-ID compatibility facade: selected because it meets the request
  while retaining durable state and the zero-config fallback.

## As implemented (2026-11-07, after review 6e9b161e and fix 0cd3da29)

The shipped worker path differs from the design above in three deliberate ways:

- **No worker cursor or checkpoint frames.** The worker runs the existing in-process
  `slackConnection` / `discordGateway` code; every received event is an awaited host `accept`
  request, and idempotency is the host inbox's provider/event-ID dedupe (plus the journal claim).
  A worker restart may replay events; the host drops the duplicates before any task effect.
  A crash can LOSE events, never duplicate them: Slack envelopes are ACKed inside the worker
  before the host accepts them (the 3 s deadline), and a respawned Discord worker IDENTIFYs
  fresh instead of RESUMEing, so gateway events during the restart backoff are not redelivered
  (review e0d2d8da N3). Durable inbound across a crash would need a worker-side spool.
- **Fallback while live.** After the bounded restart backoff is exhausted, the host kills the dead
  worker first and then switches that provider's owner to the compatibility adapter while the
  receive connection stays up. There is never a moment with two live owners of one bot token.
- **One wire fence.** Worker calls use the same predicate as the in-process adapter
  (notifications gate, bot lease, ready state, anchor, service open); a worker that times out
  three calls in a row is treated as hung and killed, so its owner restarts it.
- **Compatibility under `CEZ_DRY_RUN=1` and injected test transports.** Those paths never spawn
  a worker.

Worker bundles inline the contract and SDK, so `inline-contract.mjs` never rewrites them after
hashing; `check:pack` loads `dist/bundled-chat/catalog.json` and verifies each entry's SHA-512.
The worker receives access tokens only; Slack rotation is a host `rotate` request.
`bundled-chat.integration.test.ts` builds the real artifacts and spawns them.
