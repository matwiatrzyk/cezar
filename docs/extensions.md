# Extensions

Settings → Extensions installs trusted npm packages or built local folders globally. Choose
the project in that screen, review the exact artifact and requested access, then enable it.
Installation alone never grants project access. Local folders have Reload; npm updates resolve
the original requested package/range again. Preview and install use the same immutable snapshot.

V1 supports commands, declarative panels and forms/settings, informational task events and
external chat providers. Task proposals open the normal editable new-task form; they never
start a run. Tracker and runner extension APIs are deferred.

Each enabled extension/project pair has its own Node worker. This contains failures, **not
malicious code**: extensions run as your OS user and can access files and the network. Only
install code you trust. Official host APIs fix project identity, check declared permissions,
encrypt extension secrets and redact known secret values from logs and worker results/errors.

Disable fences host mutations, removes contributions and stops the worker. Unexpected worker
failure is shown as Failed; review and retry explicitly. Approved enabled workers restore when
the project opens after a cockpit restart. Updates stop affected workers, snapshot extension
data and owned secrets, and restore the previous version after failed activation. Additional
permissions/capabilities require project approval again. External platform effects cannot be
rolled back; activation must not perform migrations with external side effects.

Uninstall stops the extension in open projects and removes its global installation record.
Data is kept by default. The explicit delete-data choice removes extension-owned data/secrets
from registered projects; shared task history and chat grants/receivers are retained. Reinstall
requires approval again. Another extension and the three bundled chat providers keep working.

Chat providers appear under Integrations after enablement. Use the existing credential,
discovery, test-send and person-approval flow there. Software approval does not approve a
person to control tasks. Telegram, Slack and Discord retain their existing routes, IDs,
credentials, grants and journals; upgrading does not require re-pairing. External providers use
`extensionId/localId`, scoped to one canonical project root.

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
