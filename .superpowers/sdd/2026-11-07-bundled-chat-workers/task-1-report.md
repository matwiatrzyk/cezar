# Task 1 report — bundled provider artifact catalog

## Status

Implemented the bundled provider manifest/catalog contract. The loader reads the generated
`dist/bundled-chat/catalog.json`, accepts only `slack` and `discord` manifests with matching
`.v1` formats, rejects duplicate IDs, path traversal, missing/non-file entries, and SHA-512
integrity mismatches. `ExtensionManager.bundledProviders()` exposes discovery without activation.
External chat registration now rejects reserved bundled IDs and formats.

The service build/package wiring now runs `scripts/build-bundled-chat.mjs` after TypeScript
build. When bundled provider source directories exist, it bundles their TypeScript entrypoints,
copies manifests, writes an integrity-bearing catalog, and `check:pack` verifies both worker
entries are present in the npm tarball. With no bundled provider source directories (as on this
Task 1 branch), the build helper leaves no empty catalog behind so the existing compatibility
path remains usable until Tasks 3 and 4 add the workers.

## Commits

- `feat: add bundled provider artifact catalog` (this task)

## Tests and checks

- `timeout 300 npx vitest run packages/cezar/src/extensions/bundled-catalog.test.ts packages/cezar/src/pack-check.test.ts` — passed, 2 files / 12 tests.
- Initial required red test run was performed before implementation and failed because
  `./bundled-catalog.ts` did not exist.
- `npm run check:pack -w @open-mercato/cezar` — attempted; failed because this checkout has no
  built cockpit under `web/dist`.
- `npm run build -w @open-mercato/cezar` — attempted; blocked by pre-existing contract/API drift
  in automation and dashboard modules (many missing exports such as tracker automation schemas).
- `npm run build:web` — attempted; blocked by pre-existing missing exports from the api-client
  (for example `trackerChangedEventSchema` and `hostUsageSchema`).
- `git diff --check` — passed.

## Concerns / follow-up

- Tasks 3 and 4 must add `bundled-chat/slack` and `bundled-chat/discord` source directories with
  `manifest.json` and TypeScript entrypoints. Until then, the packaging helper intentionally does
  not emit a catalog.
- Full build and package validation should be rerun after the contract/api-client work on the
  parent branch is synchronized and after the two worker artifacts exist.
