# Cezar extension SDK

Public ESM JavaScript, declarations and Zod schemas for extension API 0.1. Requires Node 20+.
The only runtime dependency is public Zod; no private cezar packages are needed.

Export a default `defineExtension({ activate(context), deactivate() })` object from your
built entry point. Activation may return a disposable. The worker awaits its disposal,
then calls `deactivate()` without arguments. Host calls are unavailable during shutdown:
clean up local registrations and resources there, rather than writing storage or logs.

The separate manifest accepts the existing `entry/actions/permissions` format and the
canonical `schemaVersion: 1`, `main`, command `title`, and `tasks.read` aliases.
Parsing normalizes these to `entry`, command `label`, and `project.read`.
Conflicting aliases and unsupported capabilities fail validation. Supported capability
declarations are `commands`, `panels`, and `taskEvents`; these describe existing worker
APIs and do not grant permissions. Permissions remain the authorization boundary.
Manifest contributions can use `actions/panels` or `contributes.commands/panels`.

Commands receive `(input, context)`; only legacy `onAction` receives an action id first.
Panel providers take no arguments. All data and logger calls return promises.
Context contains the host-selected project id and permissions, not a filesystem root.
Task proposals are receipts, not task launches. Task events are informational with no
durable replay; reload a snapshot on a resyncRequired notification. Forms, trackers, runner adapters
and other future capabilities are not advertised by this SDK.

See `examples/extensions/project-summary` in the source repository for a minimal author
project. Run `npm test`, `npm run typecheck`, and `npm run test:pack` here.
The pack check installs the tarball in a temporary project outside the workspace,
builds the example, exercises its lifecycle, and removes the temporary project.
