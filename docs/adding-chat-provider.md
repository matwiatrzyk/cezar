# Adding a local chat provider

Implement providers as public SDK extensions. Telegram, Slack and Discord live in
`packages/chat-plugins/{telegram,slack,discord}`; Cezar ships the same independently built
artifacts that can be installed separately. The private bundled worker runtime and IPC are
retired. Native host descriptors preserve IDs, formats and presentation; they are not the
implementation template for a new transport.

## Read first

Read [authoring extensions](authoring-extensions.md), [extensions](extensions.md), and AGENTS.md.
The independent chat plan (`.ai/specs/2026-11-09-independent-chat-plugins-plan.md`) records the
migration requirements; older chat specs describe historical designs. Use the
public packages and [Mattermost example](../examples/extensions/mattermost) as references.

## Boundary and lifecycle

Declare `contributes.chatProviders` and register an `ExtensionChatAdapter` through
`context.chat.register`. Implement identify, inspect, send, clearButtons, acknowledge,
isMember and the declared receive model using the public `@open-mercato/cezar-extension-sdk`.
Keep platform HTTP/socket parsing, reconnect and error classification in the package;
declare its runtime dependencies and host feature requirements.

The host owns consent, pairing, grants, Confirm, durable acceptance, deduplication, checkpoints,
bot leases, credentials and task effects. Never give an adapter a run store, project context,
vault path, command executor or agent environment. Slack rotation uses the public host credential
profile: refresh tokens and client secrets stay in the host. Software approval does not grant a
person permission to control tasks.

Honor operation cancellation and activity checks immediately before external effects; dispose
must stop receives and settle outstanding work before ownership passes to a successor. The public
session receive API supports long-lived connections, and an adapter that provides it needs no
V1 `receive(after)`, which stays supported for adapters without a session. Preserve
stable event IDs and advance checkpoints only after durable host acceptance. Telegram uses native
ordered offsets/epochs, including eventless checkpoints. Slack and Discord socket claims are not
durable upstream replay guarantees; do not promise exactly-once delivery.

Keep IDs opaque strings and timestamps in milliseconds. Respect platform text/button limits,
escape markup, suppress unintended mentions and classify errors without leaking tokens.
Bot-connected replies and notifications use the shared host budget and receipt tracking.
Never fall back to a webhook send after a bot send fails: it would have no trustworthy bot receipt.

## Identity, state and selection

External providers normally use `extensionId/localId` and `extensionId/localId.v1`.
Native aliases `telegram`, `slack`, `discord` and their `.v1` formats are host-controlled:
a package name or manifest alone cannot claim them. Verified delivery metadata or an explicitly
approved project selection binds a public implementation to a canonical alias before chat storage
recovery. Boot chat and HTTP extension management share one manager.

Existing receiver IDs, pairings, grants, journals, vault records and bot leases retain their
meaning. Native leases remain under `~/.cezar/chat/<provider>/[dry-run/]bots/<botId>/` and
project journals under `.ai/cezar/webhooks/chat/<provider>/`. Selection does not migrate these
records or require re-pairing. Preserve same-receiver **Add task control** transactions and
webhook-only receivers; do not introduce a second receiver or configuration form.

Install a candidate in Extensions, then preview and explicitly approve its project selection.
Installed selections pin the exact artifact across host and installation updates. Disable or
uninstall never silently selects shipped code. Returning to the shipped artifact is a separate,
explicit selection. Failed activation rollback restores code and approval metadata, never old
vault contents, rotation state, cursors or journals.

## Delivery and operating modes

`scripts/build-chat-plugins.mjs` builds the SDK and standalone packages, then
`packages/cezar/scripts/build-chat-delivery.mjs` copies the public artifacts into
`packages/cezar/dist/chat-plugins/<provider>/` and stamps `catalog.json`. The delivery loader
verifies artifact integrity and manifest/package identity before granting native aliases.
Adapter versions are independent of the host release. A distribution pins its shipped versions
and digests; shipped copies update with the host, not separately through Extensions. An explicitly
selected installed artifact stays pinned independently.

| Mode | Chat implementation |
| --- | --- |
| Local, extensions on (default) | Verified shipped public artifacts, or explicitly selected installed artifacts, through the ordinary extension worker host. Configured bots need no npm download or new installation. |
| Local, `CEZ_EXTENSIONS=0` | Only verified shipped public artifacts through the trusted in-process SDK facade; no child worker. Installed selections stay unavailable with saved metadata retained. |
| Hosted | No chat adapter. Extension inventory is hidden; install/enable/disable/invoke and chat selection are refused. |
| Dry-run / explicitly injected test transports | Deterministic mock/test seams, not live-platform evidence. |

Chat remains opt-in: `CEZ_WEBHOOKS=1` enables receivers/setup and `CEZ_CHAT_INBOUND=1` enables
task control. Missing, tampered, disabled or failed selected artifacts never silently fall back
to private code or another implementation. The facade accepts only verified shipped artifacts,
not arbitrary installed code. Workers contain failures but are not a security sandbox: they run
as the Cezar user with that user's filesystem and network access.

## File map and configuration

| File or folder | Responsibility |
| --- | --- |
| `packages/chat-plugins/<provider>/` | Standalone package, manifest, public SDK adapter, platform tests and pack smoke. |
| `packages/extension-sdk/src/` | Public schemas/context and adapter types; keep additions compatible with API `0.1`. |
| `packages/cezar/src/extensions/delivery-catalog.ts` | Verify host-delivered artifacts and canonical identity. |
| `packages/cezar/src/extensions/manager.ts`, `project-runtime.ts` | Project selection, approval, activation and runtime ownership. |
| `packages/cezar/src/extensions/trusted-chat-worker.ts` | Verified shipped-only in-process facade. |
| `packages/cezar/src/chat/host.ts`, `registry.ts` | Canonical declarations, bridge composition and core lifecycle. |
| `packages/cezar/test/e2e/package-chat-runtime.test.ts` | Packed host/SDK/plugin tests against simulated platforms. |

A normal external provider needs no new HTTP family or private host transport. Use existing
extension chat routes and declarative setup metadata. Extensions manages software; project
Integrations manages credentials, discovery, receivers, pairing and person approval. Keep one
canonical provider form, including for a selected public replacement. Changes to existing native
routes must preserve contract schemas, chained builders and validation middleware; see AGENTS.md.

## Verification and remaining limits

Run adapter tests and `npm run test:pack` in each changed package. For host integration use bounded
typecheck, build/pack and relevant simulated runtime tests, plus the docs checker. Do not use live
credentials or platforms. A regression test must fail without its fix.

Direct cockpit tarball installation is unsupported. Install a built local folder with runtime
dependencies or an available npm package version.

### Explicit adapter disable and older hosts

The verified public-artifact composition keeps ordinary worker retirement separate
from an explicit adapter selection change. Restart, crash recovery and replacement
retain consent. Explicit disable drains receive work, writes the existing inbound
receiver `enabled: false` fields, and pauses bot-attached notification receivers.
Grants, native cursor/epoch, vault records and bot ownership are retained. These
fields remain readable by the supported `875b5243b` host.

Restoration bookkeeping is stored separately from the strict V1 inbound schema.
Explicit enable restores only configuration generations and paused receiver
revisions written by that disable. A later edit, pre-existing pause or webhook-only
receiver is not overwritten. If the process stops after a notification pause but
before its restoration revision is recorded, the receiver stays paused and needs
an explicit Resume. Failed or missing extension selection must never select a
private transport as fallback.

The test fixture `packages/cezar/test/e2e/fixtures/legacy-chat-disabled.mjs` accepts
an isolated checkout of `875b5243b` and a closed simulator project produced by the
packed Telegram test. Run it using that checkout's `tsx` loader and the same private
`CEZ_HOME`. It executes the older host's state reader and chat startup, checks the
two fixture grants and disabled/paused states, and rejects platform effects or
inbound state changes. This is an older-host compatibility probe; it does not
certify the remaining default resolver, external selection or flag-off facade.
