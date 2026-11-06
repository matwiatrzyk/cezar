# Project summary extension

Install the public SDK dependency with `npm install`, then run `npm run build`.
Install this directory in Cezar and enable it for a project, granting task read access.
The summary panel lists up to 100 tasks; Refresh reloads the snapshot, and task events
refresh it while active. Disabling disposes all three registrations.

For development before SDK publication, install its local npm tarball instead:
run `npm pack` in `packages/extension-sdk`, then `npm install /absolute/path/to/the.tgz`
in a copy of this example. The SDK's `test:pack` automates this standalone check.
