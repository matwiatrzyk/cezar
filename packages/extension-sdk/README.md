# Cezar extension SDK

`@open-mercato/cezar-extension-sdk` is the public author API for cezar extensions: ESM
JavaScript, TypeScript declarations and Zod schemas for extension API `0.1`. It requires
Node 20+, and its only runtime dependency is Zod. No private cezar package is needed.

```sh
npm install @open-mercato/cezar-extension-sdk
```

The full guide is [docs/authoring-extensions.md](../../docs/authoring-extensions.md) in the
source repository; working examples are `examples/extensions/project-summary` (commands and a
panel) and `examples/extensions/mattermost` (a chat provider).

## What it exports

| Export | Contents |
| --- | --- |
| `.` | everything below, plus `defineExtension` and the `ExtensionContext` API types |
| `./schemas` | manifest, command, panel, form, chat-provider and task schemas; `validateExtensionForm`; `EXTENSION_API_VERSIONS` / `EXTENSION_API_VERSION` |
| `./chat` | chat message, identity, event and failure schemas, `ExtensionChatAdapter`, `ExtensionChatError` |

The cezar host's HTTP routes and its worker IPC protocol are not part of this package.
(`./source` exists only for the cezar workspace, which consumes the schemas as TypeScript
source; it does not resolve from an installed package.)

## Writing an extension

Add a `cezar-extension.json` manifest (`id`, `name`, `version`, `apiVersion: "0.1"`, `main`,
`capabilities`, `permissions`, `contributes`). Supported capabilities are `commands`,
`panels`, `taskEvents`, `forms`, `settings` and `chatProviders`. Capabilities describe the
worker APIs you use; permissions (`project.read`, `project.write`, `task.create`) are the
authorization boundary. The legacy `extension.json`, `entry`, `actions` and `onAction` forms
remain accepted, as do the `schemaVersion: 1`, `main`, command `title` and `tasks.read`
aliases; parsing normalizes them to `entry`, `label` and `project.read`. Unknown values and
conflicting aliases fail validation.

Export a default `defineExtension({ activate(context), deactivate() })` from the built entry
point, and register only the contribution IDs the manifest declares:

- `context.commands.register(id, (input, context) => result)` — a command. Only legacy
  `onAction` receives the action id first.
- `context.panels.register(id, () => panel)` — declarative panels: text, status and table
  blocks plus action buttons. No HTML or scripts.
- `context.forms.register(id, () => form)` — forms declared under `contributes.forms`;
  submission is validated against the manifest's fields before the form's command runs.
- `context.chat.register(id, credentials => adapter)` — a chat provider declared under
  `contributes.chatProviders`. Throw `ExtensionChatError` for bounded transport failures.
- `context.tasks.list()` / `context.tasks.propose()` — proposals return a receipt and are
  offered to the user in the normal new-task form; nothing launches directly.
- `context.taskEvents.subscribe()` — informational, no durable replay; reload a snapshot on
  `resyncRequired`.
- `context.storage`, `context.secrets`, `context.logger` — every call returns a promise.

Activation may return a disposable. On shutdown the worker awaits its disposal, then calls
`deactivate()` without arguments. Host calls are unavailable during shutdown, so release
local registrations and resources there instead of writing storage or logs. The context holds
the host-selected project id and permissions, not a filesystem root.

Extensions run as your user in a separate Node process: the worker isolates failures but is
not a security sandbox. Install only code you trust.

## Versioning

`apiVersion` — not the npm version — is the compatibility contract. It stays `0.1` until 1.0;
changes within it are additive. The package is released in lockstep with cezar, so depend on
it with `>=0.1.0 <1.0.0`. See the guide's Versioning section for what a host does with other
`apiVersion` values.

## Developing this package

Run `npm test`, `npm run typecheck` and `npm run test:pack` in this directory. The pack check
needs the service built first (`npm run build` at the repository root). It installs the SDK
tarball in a temporary project outside the workspace, builds both examples, exercises their
lifecycles, activates the project-summary example in an installed cezar tarball, and removes
the temporary project.
