# Tracker vault: fourth full review

Reviewed entire task diff `2e16d703..26ab9347` (61 files, including accumulated review artifacts), not only the latest fixes. Local read-only production-code review. Verdict: **changes required** for one newly reproduced P2 defect.

## P2: Jira transition rejection is reported as completed

Location: `packages/cezar/src/server/tracker/jira.ts:439-440`; shared transport at `transport.ts:63-64`, receipt consequence at `task-access.ts:146-157`.

`TrackerHttp.json` permits HTTP 400 through to the JSON parser for Linear GraphQL error handling. Jira transition POST uses that same helper but validates neither the HTTP status nor the returned body. Only the comment branch validates a response. A transition returning HTTP 400 with a JSON error body therefore resolves normally. `executeTrackerOperation` interprets the normal resolution as confirmation, persists `completed`, and replays that false success on subsequent attempts with the same ID. This is a business correctness defect: a rejected status update is reported as confirmed.

Reproduction: copied the current Jira suite to a temporary review-only file and inserted a test using its existing `taskClient({ writeStatus: 400 })` helper. Called `driver.act` with a valid transition/precondition and asserted rejection. Actual result: promise resolved `undefined`. One test failed, 36 skipped. Temporary source file removed. Minimal reproduction retained in `.ai/qa/tracker-fourth-review-jira400-repro.txt`; output `/dev/shm/tracker-fourth-review-jira.log`.

Fix direction: make HTTP 400 JSON pass-through specific to GraphQL callers, or preserve/check transport status explicitly for Jira mutations. A failed transition must not produce a completed receipt. Preserve Linear rate-limit/error parsing and Jira 204 success, and do not introduce automatic mutation retries. Cover the resulting receipt as well as adapter behavior.

## Other review outcomes

- Latest timeout-queue fix retains the predecessor chain until settled; the real-20-second regression passes. Cold JQL list/search fallback cases and mutation no-fallback guards pass. Updated extension guide now describes encrypted records and legacy migration correctly.
- Storage reviewed: encrypted owner-bound records, bounded ciphertext, private files, migration UUID preservation, conflict/no-plaintext-fallback, markers, read-only degradation, committed-save reconciliation and missing-key guards. No additional confirmed storage defect in this pass.
- Security reviewed: project/run/epoch-bound capability lookup, per-operation grants, connection/scope rechecks in service wrappers including immediately before send, token redaction registration, request-origin guard, strict operation schema and redirect refusal. No additional evidenced credential leak. Same-user key/files/control-plane access remains the documented trust limitation.
- Lifecycle/business reviewed: start/Continue share context/environment helper; legacy/offline paths degrade; naming bypasses context; variant grants and child non-inheritance; automation review badge/log, access-only checkpoint preservation, CLI grant narrowing, context limitations and durable operation replay.
- Architecture/conventions reviewed: shared Zod types, chained validated routes and project aliases, backend environment seam, deletion paths, inline-contract publication, env/compatibility/reference/provider docs. No additional actionable architecture finding established.
- UI: grant/editor and table component tests pass. No browser or real-backend acceptance claim.

## Current verification

- Root focused server selection: **49 suites / 668 tests PASS**, `/dev/shm/tracker-fourth-review-tests.log`. Includes tracker, automations, profile wiring, secrets, route and contract checks, task API and agent env. Uses existing native Vitest config `/tmp/cezar-tracker-vault-audit.vitest.mjs` with current-source package aliases and TMPDIR=/dev/shm, not a clean install.
- Web editor/table: **2 suites / 28 tests PASS**, `/dev/shm/tracker-fourth-review-web.log`, current-source native config `/dev/shm/tracker-fourth-web.vitest.mjs`.
- `npm run typecheck` PASS, including server prebuild; `/dev/shm/tracker-fourth-review-typecheck.log`.
- `npm run build:web` PASS (bundle-size advisory); `/dev/shm/tracker-fourth-review-build-web.log`.
- `npm run check:pack` PASS: 932 files, 109 web/dist files; `/dev/shm/tracker-fourth-review-pack.log`.
- Diff whitespace checks PASS. Newly added review reproduction FAILS as described above; passing existing suites do not cover this rejection.

No full monorepo test suite, clean installation, browser e2e, real Jira/Linear writes or native platform-keychain acceptance performed. No production edits, commits, push or new PR during this review. The fork branch remains unchanged by this review.
