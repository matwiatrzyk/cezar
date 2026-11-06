# Adding a local chat provider

The built-in Telegram, Slack and Discord adapters share the same core orchestration and
conformance contract. Their notification-only webhook receivers remain backward compatible;
bot-connected receivers use the provider transport and shared budget.
Built-in adapters are compiled in, while installed adapters use the same operation-shaped
boundary through `ChatExtensionBridge`. Extension provider IDs use `extensionId/localId` and
persist as `extensionId/localId.v1`; existing provider IDs, pairings and grants are unchanged.

## Read first

Read `.ai/specs/2026-11-04-chat-providers.md`, the Telegram setup/replies spec, and AGENTS.md.
Then read `packages/cezar/src/chat/provider.ts`, `connection.ts`, `service.ts`, `runtime.ts`,
`setup.ts`, and the Telegram adapter. Keep the core responsible for consent, pairing, grants,
confirmed previews, durable claims, authorization, ownership, recovery, redaction and budgets.
The transport must never receive a run store, project context, vault, command executor, or
agent environment. Construction and descriptor lookup must perform no network I/O.

## Boundary and lifecycle

`ChatServiceDescriptor` identifies the provider, format, ID constraints, credential fields,
limits and presentation. `chat/registry.ts` registers installed descriptors. `ChatTransport`
is an authenticated, injected session: identity, destination inspection, send, clear buttons,
acknowledge, membership and connection. The composition root binds credentials and network
policy. The provider receives only credential values or a credential-resolving wire client.
An extension implements serializable `identify`, `inspect`, `send`, `clearButtons`, `acknowledge`
and `isMember` operations. The bridge adds a generation to each request, fences disabled or
rotated adapters before and after asynchronous effects, and validates returned values/events.
Functions, AbortSignals, journals and run stores never cross this boundary.
`server/telegram-service.ts` is the existing Telegram composition facade; its dependencies stay
live so credential rotation and simulated transports are not snapshotted during construction.

`ChatMessage` contains rendered text and generic `{text, data}` buttons. `ChatReceipt` contains
opaque string chat/message IDs. The adapter converts these into wire markup and callback
fields. Implement `ChatPresentation` for escaping, mention suppression, command addressing,
discovery links, task notices and failed-source outcomes. Limits apply after rendering.
Never truncate an escaped document halfway through an entity. The shared budget takes the
provider's chat/bot rates; replies and durable outbound notifications must use the SAME budget.
The adapter classifies transport failures as auth, conflict, rate_limited (milliseconds),
gone, transient or blocked. Do not pass platform status codes or credential-bearing errors
into the core. A transient membership failure returns unknown, never “not a member”.

A connection starts only when the service's existing gates, explicit consent and demand allow
it. Stop must cancel receives and settle outstanding effects before the ownership lease is
released. Use `needed`, `assertCredentials`, and `onHealth`; preserve the guard immediately
before every wire effect. Health's `polling` and `lastSuccessfulPollAt` names remain HTTP
compatibility vocabulary, even for a socket connection. They do not require polling.

Socket/gateway providers emit `ChatEvent` to `options.accept`: message, button, membership or
start. IDs are opaque; dates are milliseconds. A group message is either explicitly addressed
or a reply to a bot receipt; unaddressed unrelated group messages are ignored. Normalize native
commands to the shared text commands. Map thread/message references to the ORIGINAL bot receipt,
not the latest message in the thread. Cross-chat reply/button receipts are rejected at ingress.
Discovery events carry the setup code; never infer permission from a platform mention alone.

`ChatInbox` serializes and durably deduplicates socket events before effects. A failed or
interrupted claimed event is not replayed after restart: uncertainty must not become a second
task or answer. Its recent-ID ledger is bounded to 1,000 events. Provider reconnect/resume code
must prevent older redelivery beyond that window and must not claim exactly-once network
delivery. The Telegram adapter instead uses the narrow `ReceiveJournal` port for its native
offset protocol. Its six-day offset-epoch policy lives in the adapter; the shared journal has
no implicit polling timeout. An internal numeric sequence is a journal position, not a platform
message or user ID. A provider gets this narrow journal port, never the full state store.

## Credentials, storage and receiver modes

`chat/credentials.ts` owns immutable fingerprinted references in the project SecretStore,
with audience `cezar` only. Nothing is put in `process.env`. Telegram's URL/token codec remains
in `webhooks/telegram-secrets.ts`; it delegates persistence to `ChatSecrets`. A future multi-key
provider uses `encodeChatCredentials` / `decodeChatCredentials` for its declared credential record in one private blob,
validate/decode it at the composition boundary and redact every constituent secret. The setup
HTTP field `token` currently carries the opaque credential string to preserve Telegram's wire
shape; its provider-specific codec can serialize a multi-key record. Never store a bot token
in a receiver URL for Slack or Discord or expose a blob through public projections.

Stored names are `chatId`, `chatSecret`, `chatSource`, with `provider` on sources and inbound
state. Correlation message IDs are strings. Correlations also store `privateChat`; the core
must not guess privacy from a minus sign. Provider ID schemas validate persisted identities.
Public source projection omits bot, chat, actor and platform message IDs.
Ownership is namespaced under `~/.cezar/chat/<provider>/bots/<botId>/` (separate dry-run scope).
As before, ownership/binding metadata is per-user while the full inbound journal belongs to
the project's webhook state directory, now `webhooks/chat/<provider>/`; it is not duplicated
into the home lease directory. No read-both parser or legacy-name migration exists.

A webhook-only receiver keeps its original URL, format and absent bot fields. Core setup can
carry `receiverId` plus its expected revision through a credential-led setup, then pass that
same ID to the activation transaction. Do not create a second receiver for **Add task control**.
Optional `chatSecret`/`chatId` fields are preserved by ordinary same-format settings edits.
The future provider's activation transaction must atomically attach those fields, preserve the
receiver's identity, invalidate obsolete delivery snapshots, test the bot destination, and
bind the discovered chat before approval. The existing Telegram transaction is the example.
The Slack/Discord bot activation and outbound wire branches are intentionally not registered
in Stage A: implementing them belongs to those providers, with upgrade regression tests.
Bot-connected notifications must use the provider and shared budget, while receivers without
bot fields keep the incoming-webhook sender. Never fall back to the webhook after a bot send
fails: a reply would have no trustworthy bot receipt. Downgrade limits are recorded in
`BACKWARD_COMPATIBILITY.md`.

## Exact extension file map

Keep Slack work in `providers/slack/` and Discord work in `providers/discord/`; coordinate the
small shared registration edits once when integrating their branches.

| File or folder | Provider addition |
| --- | --- |
| `packages/cezar/src/chat/providers/<id>/` | Identity, receiving/reconnect, session, rendering, error and credential codecs; simulated platform tests. Telegram's folder is the concrete reference. |
| `packages/cezar/src/chat/registry.ts` | Register the compiled-in service descriptor; no dynamic loader. |
| `packages/contract/src/chat.ts` | Refine the provider's ID/credential constraints and instantiate the existing schema factory; all HTTP shapes have one definition. |
| `packages/contract/src/index.ts` | Export provider contract instance/types if needed. Existing `Telegram*` exports stay compatible. |
| `packages/cezar/src/server/telegram.ts` | Reuse `createChatRoutes(provider, resolver, availability, schemas, projectValidator)`; never copy its handlers or add loose untyped routes. |
| `packages/cezar/src/server/server.ts` | Chain/mount provider routes under both existing project aliases; add demand-driven invalidation topic using the existing bus. |
| `packages/cezar/src/server/<id>-service.ts` | Bind the transport to the generic `ChatInbound` and private credential access, as Telegram's facade does. |
| `packages/cezar/src/webhooks/service.ts` | Instantiate the provider service; attach existing receivers transactionally; select its budget, outbound send and receipt recording for bot-connected receivers. Leave webhook-only branches unchanged. |
| `packages/cezar/src/webhooks/endpoints.ts` | Add the provider credential resolver/attachment transaction alongside Telegram's codec, retaining optional stored fields and cezar-only secret ownership. |
| `packages/web/src/lib/chat-providers/<id>/index.ts` | Add the bot descriptor: fields, credential serializer, API facade, subscription, discovery/group hints, ID predicates and help links. |
| `packages/web/src/lib/chat-providers/index.ts` | Already registers Slack/Discord tiles; only change if adding another platform. |
| `packages/web/src/routes/settings/integrations-section.tsx` | Generic gallery/panel; add the same-receiver upgrade entry when the provider's bot capability is enabled. |
| `packages/web/src/routes/settings/telegram-{wizard,inbound,chats}.tsx` | Shared `ChatWizard`/`ChatSettings` implementation and compatibility exports. Extend discovery-specific copy only through descriptors; do not fork their state machines. |
| `packages/cezar/src/chat/test-support/conformance.testkit.ts` | Run unchanged with the provider's real session/renderer over simulated wire calls. |
| `packages/cezar/src/server/contract-parity*.test.ts`, `route-parity.test.ts`, `typed-bodies.test.ts` | Register/prove provider contract and route parity, middleware validation and scoped aliases. |
| `packages/web/e2e/` | Provider-local simulated setup, same-receiver upgrade, private/group reply and consent flows. |

No provider should need its own permission system, action journal, source observer or run-store
access. A required change to one of these shared rules needs a focused core regression test.

## Verification

The shared conformance suite currently exercises both Telegram and a simulated socket provider
with nonnumeric identities. It covers pairing, one-time question buttons, Confirm before task
creation, final replies, unmentioned group replies, credential fencing, rate limits and removal
without grant revocation. Existing Telegram suites retain the deeper ownership, restart,
consent, vault, privacy and delivery-race regressions. The socket journal separately tests
concurrent deduplication, persistence failure, crash uncertainty and cross-chat receipts.

Run bounded focused tests, all-workspace typecheck, build/pack, docs check and both simulated
Telegram e2e configs. Add provider-specific conformance and upgrade tests before registering a
real transport. Do not use real credentials or platforms in tests. A regression fix must have
a test proven red without the fix. Stage A candidate validation is not the four independent
review/fix rounds: the parent coordinates those after this candidate is committed.
