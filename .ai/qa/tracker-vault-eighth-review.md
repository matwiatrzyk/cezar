# Eighth tracker-vault review

Reviewed range: `2e16d703..aa13852d677802ec5237a93cd3986d7cafb01f3c`.
Verdict: **changes required**. Two independent read-only Cezar reviewers plus parent validation. No production edits or push during this review.

## Confirmed findings

### P2 / Major: cached key can make successful saves unreadable after restart

`packages/cezar/src/workspace/secrets.ts:144` and `:331`; `packages/cezar/src/server/tracker/connections.ts:102` and `:150`.

A running server retains its SecretStore. If its secrets directory is deleted or an older complete home backup is restored while it runs, the in-memory key survives. Managed sealing and read-back verification use that cached key rather than establishing that the persisted key can decrypt the record. Save reports success; a fresh process cannot decrypt. More seriously, migration of another project's intact legacy record verifies against the cached key and deletes plaintext despite no matching durable key. The cache predates this task; destructive tracker migration newly relies on it.

Parent independently rebuilt the reviewer worker and ran `process-repro.mjs`: deletion and backup restore both produced saved=true/freshReadable=false; migration produced migrationReadable=true/plaintextRemoved=true/freshReadable=false. Real filesystem, separate Node processes, AES encryption, synthetic credentials, file-key backend only. This concerns explicit live storage reset/restore, not ordinary registry config.json.bak restoration. Harness exit 0 asserts the defect observations, not correct durability.

Correction: independently establish current durable key identity before commit/plaintext deletion; safely reject or reload after metadata changes, preserve plaintext when verification fails, never replace a merely unavailable established key. Add restart tests for a live cached instance.

### P2: late context fetch recreates content after task deletion

`packages/cezar/src/workflows/run.ts:1598-1607`.

Cancel during tracker context fetch before a provider session starts. cancelAndWait returns true, deleteRun succeeds and removes tracker context. The outstanding fetch then finishes and the captured run publishes its JSON unconditionally. Issue description/comments reappear as an orphan file after deletion. This is persisted-content cleanup failure, not evidence of a provider mutation after cancellation.

Parent reran the reviewer's real-filesystem RunManager/RunStore seam reproduction against the identical branch: deleted-file expected-absence assertion fails, normal completion control passes. Inspecting cancel/dropActive, deleteRun cleanup and unconditional publication confirms the ordering.

Correction: fence async snapshot publication by execution ownership and coordinate publication with deletion, including temporary-file cleanup. A pre-fetch check alone is insufficient.

## New coverage in this pass

- Real multiple-process first-key initialization (8 writers), same-ID operation replay and distinct-ID serialization (6 processes), actual SIGKILL during migration and operation send, real readonly filesystem reads.
- Live-instance vault deletion and full backup restore, restart decryption assertions.
- Late tracker fetch versus cancellation/deletion; non-default runner env paths, remote/loopback plumbing, graph epochs and cleanup.
- Package-consumer install and built CLI execution, browser tracker grant editing.

Parent independently reran storage controls: 8-process convergence, SIGKILL migration recovery and readonly legacy/encrypted reads pass. Operation-process controls are reviewer evidence; source and logs inspected, not rerun by parent.

## Validation and limits

Parent evidence:
- 55 selected server suites / 714 tests PASS: `/dev/shm/tracker-eighth-server.log`.
- `npm run test:package`: 25/25 PASS, including consumer installation/CLI. Initial inherited npm EALLOWSCRIPTS failure avoided using isolated empty user/global npm configs, without enabling install scripts. `/dev/shm/tracker-eighth-package-cleanconfig.log`.
- Browser tracker-access test: 1/1 PASS using temporary config, built server and no model calls. Default config could not load unrelated @ai-sdk/openai. Temporary config removed; browser artifacts retained in tree units/root-eighth/browser-artifacts. `/dev/shm/tracker-eighth-e2e-retry.log`.
- Built CLI against synthetic real loopback HTTP: payload/path/auth, completed exit0 and unknown exit2 PASS. `/dev/shm/tracker-eighth-built-cli.log`.
- Independently reproduced both findings: `/dev/shm/tracker-eighth-root-repro.log`, `/dev/shm/tracker-eighth-root-storage.log`.

Reviewer evidence (overlaps parent selections; do not sum): lifecycle431 server/186 web pass; recovery395 selected tests pass; contract typecheck pass. Standard unaliased tests/server typechecks encountered inherited workspace exports/dependency failures. Source-alias runs are not a full clean-install monorepo release gate. This pass did not freshly certify full build/typecheck, native keychain, Windows/macOS, real agents/vendors, power-loss durability or broad browser QA.

Both reviewer branches have empty source diffs against parent. Existing intentional compatibility reductions remain documented; no additional confirmed compatibility defect in this pass. Prior fixes are not repeated as new findings.

Detailed artifacts: tree units/f3e34ff9/review.md and late-context.test.ts; units/9c5aabac/review.md, process-repro.mjs, operations-repro.mjs and logs. Review complete; these two findings remain unfixed.

## Fix verification — 2026-10-26

Both findings fixed: SecretStore reloads durable key metadata instead of retaining process keys; snapshot publication checks captured execution identity after async work, publishes without an intervening await, cleans temporary files, and denies late capabilities. Regression cases cover live deletion/restore, second-project migration/restart, cancelled/deleted and replaced execution, normal control. Five regression assertions fail against original production sources; all42 selected tests pass after restoration. Broader55 suites/720tests pass with current-source config; unmodified npm run typecheck (including server prebuild) passes. No fresh browser/live provider/native keychain test in this fix turn. Logs /dev/shm/tracker-fix-{suite,typecheck,final-red,final-green}.log.
