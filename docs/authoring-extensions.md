# Authoring an extension

Create a separate ESM package with `@open-mercato/cezar-extension-sdk` as its only Cezar
dependency. Build before installing a local folder. Never import Cezar's private contract,
API client, server or React components. The SDK tarball includes its own runtime and types.

Add `cezar-extension.json` with `id`, `name`, exact `version`, `apiVersion: "0.1"`, `main`,
`capabilities`, `permissions` and `contributes`. See the two [examples](../examples/extensions).
Unknown capabilities and permissions fail validation. Supported capabilities are `commands`,
`panels`, `taskEvents`, `forms`, `settings`, and `chatProviders`. Legacy `extension.json`,
`entry`, `actions` and `onAction` remain accepted.

Export `defineExtension({ activate(context) { … } })`. Return a disposable which releases
subscriptions and resources. Register only declared contribution IDs:

```ts
context.commands.register('refresh', async () => ({ message: 'Refreshed' }))
context.panels.register('summary', async () => ({
  id: 'summary', title: 'Summary',
  blocks: [{ type: 'text', text: 'Plain text only' }],
  actions: [{ id: 'refresh', title: 'Refresh' }],
}))
```

`tasks.list()` needs `project.read` (`tasks.read` is an alias). `tasks.propose({title,prompt,
workflow?})` needs `task.create`; its receipt always has `accepted: false`. Proposals returned
by a command are offered as links to the normal new-task confirmation form. No direct launch
API is available. Task events are informational, bounded and may emit `resyncRequired`; reload
the snapshot after that signal. They are not an automation delivery queue.

`storage.get/set` accept JSON keys/values in this extension/project namespace.
`secrets.get/set` use the existing encrypted vault. Do not put secrets in storage, output,
exception messages or environment variables. Known values are redacted, but the host cannot
recognize arbitrary encodings of a secret. `logger.info/error` are redacted too.

Declare forms under `contributes.forms`, with `id`, `title`, `commandId` and `fields`.
Fields have a `key`, `label`, `type` (`text`, `password`, `number`, `boolean`, `select`),
optional `required`, and `options` for selects. Register an optional dynamic provider with
`context.forms.register`; it may return saved `values`. Password defaults are withheld.
Submission validates the manifest's fields before invoking the declared command; save settings
through storage/secrets from that handler. No executable validator, HTML or React crosses IPC.

For chat, declare `contributes.chatProviders` (see Mattermost) and register a factory with
`context.chat.register(id, credentials => adapter)`. The adapter implements identify, inspect,
send, clearButtons, acknowledge, isMember, receive and optional dispose. Credential fields are
secret by default; mark a public server URL `secret: false`. The provider's required HTTPS
`discoveryUrl` is the cockpit's setup help link, and the base of the pairing link when
`identify()` returns none. Identity may return its own HTTPS `discoveryUrl` (for example the
bot's page on a self-hosted server), which wins. The host adds the one-time pairing code.

`receive(after)` returns up to 100 `{sequence,event}` records in ascending platform sequence
order. `sequence` is a nonnegative safe integer; equal timestamps are allowed, and event IDs
must remain stable. The host persists a separate platform cursor only after `ChatInbound`
durably accepts each event. Replay the cursor boundary on restart; core event-ID claims prevent
duplicate effects. Event timestamps are Unix **milliseconds**. Keep each receive under 25 seconds
and abort outstanding network requests in dispose. Do not implement task authorization or
launching in the adapter: pairing, grants, deduplication and task confirmation belong to Cezar.

RPC limits: activation 10 seconds, shutdown 5 seconds, ordinary calls 30 seconds, frames 1 MiB,
100 pending calls. A worker receives minimal environment and cannot select its host project.
Every request is generation-fenced. `ExtensionChatError` carries a bounded transport failure
when authentication, rate limiting or provider availability needs specific handling.

Registry installs use npm with lifecycle scripts disabled; dependencies requiring install
scripts and symlinked artifacts are rejected. Updates are explicit. Keep activation idempotent,
and limit migrations to local extension-owned state so rollback can restore it.

Task proposals must be awaited inside a command invocation. Each invocation returns only its own proposals; a failed command discards them. Calls from activation, task events, chat callbacks or work continuing after the command returns are rejected. The user still reviews the normal new-task form before launching anything.

## Versioning

`apiVersion` is the compatibility contract between an extension and the host, separate from
the npm versions of the SDK or your package. The SDK exports the accepted list as
`EXTENSION_API_VERSIONS` and the current value as `EXTENSION_API_VERSION`; today both are
`0.1`.

- The API stays at `0.1` until 1.0. Changes inside `0.1` are additive: new optional manifest
  fields, new capabilities or context methods. Existing manifests and adapters keep working.
- A breaking change gets a new `apiVersion`. A host lists every version it still runs, so a
  release can accept both the old and the new value for a transition period.
- The SDK package is released in lockstep with cezar, so its npm version follows cezar's.
  Depend on it with `>=0.1.0 <1.0.0` (as the examples do); the `apiVersion` you declare,
  not the SDK version, decides whether a host accepts your extension.
- A host that does not support a manifest's `apiVersion` rejects the install with a
  validation error. A stored record with an unsupported `apiVersion` (for example after
  downgrading cezar) is ignored: it is not listed or started, and the next change to the
  registry drops it. Reinstall the extension from its source after upgrading again; its
  storage and secrets are kept unless you uninstalled with data removal.
