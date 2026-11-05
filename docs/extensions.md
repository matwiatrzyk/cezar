# Extensions

Extensions are project-scoped packages or local folders with an `extension.json` manifest. Install
one from Settings → Extensions or through the project-scoped extensions API, then explicitly enable
it. The first slice supports declarative panels and declared actions.

The manifest is validated with the public Zod contract (`@open-mercato/cezar-contract`) and may
declare only the bounded permissions `project.read`, `project.write`, and `task.create`. Actions
run in a short-lived Node worker with `{ projectId, projectRoot, permissions }`; the host does not
expose the server context, credentials, or arbitrary route handlers. The worker is a containment
boundary, not a sandbox: installing an extension is a trust decision because Node workers share the
host's user privileges and can access the filesystem/network unless a future hardened runtime is
enabled.

See `examples/extensions/hello` for a complete panel/action extension. Slack and Discord remain
native adapters in this stage and are not migrated.
