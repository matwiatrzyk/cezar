# Tracker vault: second independent review — changes required

Scope: `git diff 2e16d703..701b5473`, 55 files. Read-only review; no production edits.

Review complete: 06a930ba (security/storage), 7cdb92dd (business/lifecycle), e09ae559 (architecture/quality), plus root verification. All three verdicts: changes. Consolidated verdict: **request changes before merge**. Three distinct reproduced defects; the lock race was independently reproduced by all reviewers and root.

## Confirmed by root

**High: lock acquisition race permits overlapping writes.** `packages/cezar/src/server/tracker/task-access.ts:101,150` writes the owner file asynchronously before recording the lock in `heldLocks`. A contender during that interval sees its own PID but no held lock, reaps it, and starts another write. Releasing the first acquisition lets both write concurrently; the first cleanup can also remove the second owner's lock. Use an acquisition state registered before publishing ownership, or an established lock primitive with instance ownership. Cover acquisition and release races, not only a second caller after the first is already inside `act`.

Deterministic reproduction: copy `.ai/qa/tracker-review-lock-race.test.ts.txt` to `packages/cezar/src/server/tracker/review-lock-race.test.ts`, run the command below with `src/server/tracker/review-lock-race.test.ts -t 'review: a contender'`. The test gates resolution of the real owner-file write after it reaches disk. Result: expected maximum concurrent vendor writes 1, received 2. Temporary source test removed after execution; reproduction retained as text.

## Root validation

```sh
env -u CEZ_API_URL -u CEZ_BIN -u CEZ_REMOTE TMPDIR=/dev/shm npm test -- --config /tmp/cezar-tracker-vault-audit.vitest.mjs --configLoader native src/server/tracker src/automations src/workflows/agent-profile-wiring.test.ts src/workspace/secrets.test.ts src/server/bc-route-inventory.test.ts src/server/contract-parity-tracker.test.ts
```

47 files / 613 tests PASS (26.12 seconds). Log: `/dev/shm/tracker-review-root-tests.log`. Earlier six-file subset: 112 tests PASS (included in 613; do not add counts). `git diff --check 2e16d703 HEAD` PASS.

The native temporary config pins package aliases to this worktree and supplies missing local dependencies (same config used in prior implementation evidence). Initial attempt with TMPDIR=/tmp failed BEFORE tests, errno -122 (quota). Changing only TMPDIR to /dev/shm allowed execution. This is not a clean-install/full-suite or live-provider acceptance claim.

## Reports received and checked

- Architecture/quality (e09ae559): verdict changes; independently reproduced the same live-lock race (two concurrent acts, both completed). 31 suites/357 focused tests passed in its own aliased config; contract typecheck passed; standard server typecheck and broader checks hit stale workspace/missing dependency issues. No additional evidenced defect. Report: dispatch tree `units/e09ae559/review-report.md`.
- Business/lifecycle (7cdb92dd): verdict changes; independently reproduced the same race using actual code and real filesystem with a fake provider. Latest migration, Continue, UI grants, variants and context fixes reviewed; no additional evidenced defect. Focused runs 281 and 69 passing tests overlap and must not be summed. Report: dispatch tree `units/7cdb92dd/review.md`.
- Both reviewer branch diffs against reviewed 701b5473 are empty. Findings cross-checked with root's own earlier failing reproduction. No merge required for read-only reviews.
- Security/storage (06a930ba): verdict changes; lock race plus two storage defects below. Read full report and checked empty reviewer branch diff. Root reran the exact storage reproduction successfully. Reviewer reports 338 focused tests passed; these overlap other checks and are not additive. No complete validation-gate claim.

## Additional confirmed storage findings

**P2 / Major: failed-save response after credential replacement already committed.** `packages/cezar/src/server/tracker/connections.ts:56-59,191-194`; API response `packages/cezar/src/server/server.ts:6638`. If the vault rename succeeds but directory open/fsync fails, `write()` catches the exception and returns null. The new UUID and credentials are nevertheless already on disk, invalidating the old connection association and task bindings. The API reports only failure and skips its normal success notification. Root reran the security reviewer's injection of EIO specifically into the directory fsync after the vault rename: replacement returned null; subsequent read contained a new UUID and `new-synthetic`. This is a storage-failure path, not a typical successful save. Separate pre-commit failure from committed replacement with uncertain durability, reconcile the persisted generation, and test post-rename/cleanup failures.

**P3 / Minor: accepted credential can exceed the vault's own read limit.** `packages/cezar/src/server/tracker/connections.ts:187-193` writes without checking serialized bytes; `:38,47` refuses files over 32768 bytes. `packages/contract/src/tracker.ts:332` permits 8192 characters, which is not an encoded byte bound. UTF-8 plus base64/envelope overhead can exceed 32768 bytes. Root reproduced `key: '漢'.repeat(8192)`: save succeeded, immediate inspection returned no record and a storage error. A previous connection can be replaced with an unreadable record. This is a schema/input-boundary defect; no claim that a real Linear token has this format. Check encoded size before replacement, or align the reader bound with the schema's actual maximum encoded record size. Include preservation-on-rejection coverage.

Root storage reproduction output: `.ai/qa/tracker-review-storage-repro.txt`. Exact command: dispatch tree `units/06a930ba/review.md`, section “Storage reproduction command”; run unchanged from the root worktree with `TMPDIR=/dev/shm node --import tsx`. Exit 0; synthetic temporary home only, keychain disabled, no real credential or provider access.

## Consolidated assessment

- Business/lifecycle: current source and focused tests support the fixes for legacy-run Continue, visible automation review, access-only checkpoint preservation, per-variant grants and reported context limitations. No additional confirmed business defect beyond the concurrency consequences.
- Architecture/project consistency: chained middleware-validated routes, shared Zod contract, optional persisted fields, both run launch/Continue paths, documented env/storage/CLI changes. The duplicated hand-written locking mechanism remains a correctness risk, demonstrated above. No new runtime dependency or production source edits during review.
- Security: provider credentials are no longer deliberately delivered in agent environments; managed records are encrypted with namespace/identity binding; task grants are scoped and epoch-bound. These are exposure reductions, not isolation from another process with the same OS user's access. Existing same-user control-plane/key access remains documented, not a newly discovered exploit.
- Validation: root's 47 suites / 613 tests passed with local-source aliases; the deterministic lock repro fails the serialization assertion; both storage defects reproduced independently by root. Reviewer tests corroborate but overlap. The full clean-install typecheck/build/package/browser gates are NOT certified by this review; stale workspace links, missing dependencies and quota errors affected ordinary commands. No live Jira/Linear writes or platform keychain acceptance tests.
- Scope: review complete; implementation is not approved. Fix locking and committed-save outcome handling before merge, address encoded-size rejection, then rerun focused regressions and the repository's full validation gate in a clean environment. No production code changed, branch merged, push or PR performed.

## Fix status (2026-10-26)

- **Lock race — fixed.** `task-access.ts`: same-process writers queue in memory per lock before touching disk, so a lock naming our own PID can only be a previous process's leftover; an empty lock dir we created is removed if the owner write fails. Regression `never lets a contender reap an owner that is still acquiring the lock` (the review repro) added to `task-access.test.ts`.
- **Committed save reported as failed — fixed.** `connections.ts` `write()`: once the vault rename is attempted, any later error reconciles by reading the vault back; if it holds the new record, the save is reported as successful. Regression: directory-fsync EIO after rename.
- **Oversized record — fixed.** Sealed text is checked against the reader's `MAX_RECORD_BYTES` before any replacement (write and migration); the previous record is preserved. Regression: `'漢'.repeat(8192)`.
- All three regressions fail on the reviewed source and pass with the fix. Focused suite: 47 files / 616 tests pass (same command as above); `npm run typecheck` exit 0; `git diff --check` clean. Full clean-install gate (build, package, browser) still not re-run here.
