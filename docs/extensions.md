# Extensions

Settings → Extensions installs trusted npm packages or built local folders globally. Choose
the project in that screen, review the exact artifact and requested access, then enable it.
The catalog labels host-delivered artifacts **Bundled with Cezar**, registry packages
**Public extension**, and folder installs **Local extension**. A chat contribution links
directly to that provider's single project configuration in Settings → Integrations; the
Extensions page manages software and Integrations manages credentials, receivers and pairing.
Installation alone never grants project access. Local folders have Reload; npm updates resolve
the original requested package/range again. Preview and install use the same immutable snapshot.

V1 supports commands, declarative panels and forms/settings, informational task events and
external chat providers. Task proposals open the normal editable new-task form; they never
start a run. Tracker and runner extension APIs are deferred.

Each enabled extension/project pair has its own Node worker. This contains failures, **not
malicious code**: extensions run as your OS user and can access files and the network. Only
install code you trust. Official host APIs fix project identity, check declared permissions,
encrypt extension secrets and redact known secret values from logs and worker results/errors.

Disable fences host mutations, removes contributions and stops the worker. A worker that dies
after activation restarts with backoff (1 s, 2 s, 4 s); after three rapid crashes, or a failed
activation, it is shown as Failed — review and retry explicitly. Approved enabled workers restore when
the project opens after a cockpit restart. Updates stop affected workers, snapshot extension
data and owned secrets, and restore the previous version after failed activation. Additional
permissions/capabilities require project approval again. External platform effects cannot be
rolled back; activation must not perform migrations with external side effects.

Uninstall stops the extension in open projects and removes its global installation record.
Data is kept by default. The explicit delete-data choice removes extension-owned data/secrets
from registered projects; shared task history and chat grants/receivers are retained. Reinstall
requires approval again. Another extension and the three bundled chat providers keep working.

## Bundled Telegram, Slack and Discord workers

Telegram, Slack and Discord are first-party artifacts delivered with Cezar. They are not
resolved from npm during startup, but their standalone public extension packages are part of
the release set (see [Publishing](publishing.md)) and may be installed explicitly through the
normal Extensions preview. The bundled build creates `dist/bundled-chat/catalog.json` and one
immutable artifact directory per provider:

```
dist/bundled-chat/
  catalog.json
  telegram/{index.js,manifest.json}
  slack/{index.js,manifest.json}
  discord/{index.js,manifest.json}
```

The catalog is the only loader input; Cezar does not resolve these workers through npm or install
anything at startup. Each manifest has the stable public `id` (`telegram`, `slack` or `discord`), semver
`version`, provider-relative `entry`, `sha512-<base64>` `integrity`, and matching `format`
(`telegram.v1`, `slack.v1` or `discord.v1`). The loader rejects duplicate IDs, path escapes,
missing or symlinked entries, and digest mismatches. `check:pack` also verifies that a publishable
tarball contains all worker entrypoints and manifests whenever it contains the catalog.

The host reserves `telegram`, `slack`, `discord`, `telegram.v1`, `slack.v1` and `discord.v1`; external extensions must use
qualified provider IDs such as `extensionId/localId`. Existing receiver IDs, grants, journals,
setup routes and UI descriptors remain unchanged and require no re-pairing. The host retains
credentials, secret rotation, authorization, the receive journal and task
effects; workers own only their platform sockets and bounded adapter operations.

On a local cockpit, workers are selected before chat recovery. A worker receives only copied
JSON values over the bounded, validated RPC protocol. Slack and Discord forward normalized
events through an awaited host `accept` request. The host uses stable provider event IDs and its
durable journal to deduplicate accepted events; these workers do not provide a durable replay
cursor. Slack acknowledges envelopes before host acceptance, and a restarted Discord worker
opens a fresh Gateway session. A crash or reconnect can therefore lose messages before the host
accepts them. Check the task in the cockpit before resending a request; see the
[chat delivery guidance](site/content/docs/03-features/settings-and-projects/slack-discord-task-control.mdx).
The external extension adapter's `receive(after)` cursor/checkpoint contract is a separate
mechanism and is not a delivery guarantee for bundled Slack/Discord workers.

Generation and abort checks fence stale bundled wire effects. Shutdown stops receive connections
first, settles/aborts pending calls, then stops the worker before the extension manager closes.

`CEZ_EXTENSIONS=0` disables bundled worker activation and uses the existing in-process adapter as
the sole owner, preserving configured integrations. Hosted cockpits likewise never start workers
and keep local-only restrictions. A missing or tampered artifact, or one provider's activation
failure, falls back only that provider to the compatibility adapter; the other providers remain
independent. Cezar never runs a worker and its fallback concurrently. Workers run as the Cezar
user and are isolated for failure containment, not a security sandbox.

Chat providers appear under Integrations after enablement. Use the existing credential,
discovery, test-send and person-approval flow there. Software approval does not approve a
person to control tasks. Telegram, Slack and Discord retain their existing routes, IDs,
credentials, grants and journals; upgrading does not require re-pairing. External providers use
`extensionId/localId`, scoped to one canonical project root.

Do not create a second provider settings screen. From Extensions use **Configure connection**
to open `/p/<projectId>/settings/integrations?integration=<extensionId>/<providerId>`; the
Integrations gallery's Chat category is the canonical destination.

Examples:

- [Project summary](../examples/extensions/project-summary): task snapshot, live updates and refresh.
- [Mattermost](../examples/extensions/mattermost): a standalone fourth provider using the public SDK.

The SDK is `@open-mercato/cezar-extension-sdk`, API line `0.1`. See
[authoring extensions](authoring-extensions.md). `npm run test:pack -w
@open-mercato/cezar-extension-sdk` builds both examples outside this workspace against the packed
SDK. The browser acceptance test is `packages/web/e2e/extensions.e2e.ts`.

HTTP installation operations live under `/api/v1/extensions`: list, `prepare-install`,
`commit-install`, `:extensionId/prepare-update`, and DELETE `:extensionId` (optional
`removeData=true`). Project access lives under `/api/v1/p/:projectId/extensions/access`;
enable/disable, commands, forms and panels use that project's `extensions/:extensionId` family.
Enable requires the reviewed artifact's `integrity`. Project routes retain boot-project aliases.

Explicit chat source selection uses the project routes
`POST extensions/chat-selections/:provider/preview` and `POST extensions/chat-selections/:provider/select`,
where `provider` is `telegram`, `slack` or `discord`. Send `enabled` and a `target`:
`{"kind":"shipped"}` or `{"kind":"installed","extensionId":"…","localProviderId":"…","integrity":"sha512-…"}`.
The preview returns the current and candidate records, added permissions/capabilities, and a
`revision`. Include that revision with the same input in `select`; a stale preview is rejected.
Previewing does not start code or create an approval. Hosted cockpits refuse both operations.
With `CEZ_EXTENSIONS=0`, only an explicit return to shipped code is permitted.

An explicitly selected installed chat artifact keeps its exact version independently of later
host or installation updates. Its selected local provider uses the existing native provider ID;
other contributed providers retain their qualified IDs. Disabling or uninstalling it does not
select shipped code. Missing selected bytes remain unavailable, with saved metadata retained.
A source change drains the old transport while retaining the canonical declaration. Failed
activation restores the prior code selection and approval without restoring old credentials,
cursors or chat journals. Use a fresh preview to return to shipped code explicitly.
