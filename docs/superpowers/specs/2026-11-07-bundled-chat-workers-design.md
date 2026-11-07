# Bundled Slack and Discord workers

## Intent

Move the first-party Slack and Discord adapters into the same isolated Node-worker execution
model used by external chat extensions, while preserving the zero-config behavior and every
persisted provider identity already in use.

## Goals

- Ship Slack and Discord worker artifacts inside the Cezar package; startup performs no npm
  install or network download for them.
- Run each enabled provider in an isolated worker process with the existing bounded RPC,
  lifecycle timeout, generation fencing and redaction rules.
- Keep `slack` and `discord` as the public provider IDs, their `.v1` formats, credential shapes,
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

The package build produces two immutable bundled artifacts under the service distribution. A
`BundledProviderCatalog` maps the reserved public IDs (`slack`, `discord`) to manifests, worker
entrypoints, descriptor metadata and a compatibility adapter. `ExtensionManager` activates these
artifacts before chat recovery, but registers them through a dedicated bundled registration path
that permits the stable IDs and rejects collisions with external providers.

The worker uses the existing SDK chat adapter contract. The host-side bridge remains responsible
for credentials, secret rotation, receive journaling, durable acceptance and task authorization.
Slack-specific operations are limited to token refresh/exchange and Socket Mode receive/send;
Discord-specific operations cover Gateway lifecycle, interaction acknowledgement and native
command payloads. Each operation has a Zod schema and an abort/generation check immediately
before the wire effect.

The host keeps a compatibility mode for `CEZ_EXTENSIONS=0` and for an activation failure. This
mode uses the existing in-process adapters and preserves the current user-visible behavior; it
is observable in diagnostics but never silently changes persisted identities.

## Migration sequence

1. Add bundled manifest/artifact discovery and reserved-ID registration tests without changing
   the current adapters.
2. Add worker-compatible Slack and Discord adapter entrypoints and conformance tests against the
   existing provider suites.
3. Add host RPC facades for rotation, Gateway/native interactions and receive checkpoints; run
   the worker path behind a local-only activation gate while compatibility remains available.
4. Activate bundled workers before chat recovery, test restart/crash/reconnect and verify old
   receiver/grant/journal records resolve unchanged.
5. Make the worker path the default, retain compatibility fallback for opt-out/activation
   failure, update packaging/docs, and run the full validation suite.

## Acceptance criteria

- A clean packaged Cezar starts Slack and Discord workers without installing packages.
- Existing Slack and Discord pairings continue to receive, send, rotate credentials and handle
  native interactions after restart without re-pairing.
- Killing either worker stops only that provider, recovery does not duplicate accepted events,
  and disabling the provider fences in-flight wire calls.
- Extension and chat conformance suites, typecheck, build, package checks and full `npm test`
  pass with no real credentials or network calls.

## Approaches considered

- Keep all adapters in-process: safest short-term, but does not deliver the requested worker
  isolation.
- Worker only for outbound sends: smaller migration, but inbound Gateway/rotation failures still
  crash or block the host path.
- Full bundled worker with stable-ID compatibility facade: selected because it meets the request
  while retaining durable state and the zero-config fallback.
