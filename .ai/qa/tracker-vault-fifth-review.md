# Tracker vault: fifth full review, including backward compatibility

Scope: complete task diff `2e16d703..ab9f2225`. Independent read-only reviewers: 49e2ba84 (backward compatibility), 605a3358 (technical/security), with root source inspection and reproductions. Reviewer branch diffs against reviewed tip are empty. No production edits or pushes. Verdict: **changes required**.

## Findings

1. **P2 — Filesystem errors bypass the issue-lock deadline.** `packages/cezar/src/server/tracker/task-access.ts:121-122,163-164`. `reapStaleLock` converts every readdir failure into apparent successful reaping; acquisition immediately continues before checking the deadline. An ordinary file at the lock path (ENOTDIR), persistent EACCES or similar storage fault keeps the original request spinning and holding its local queue. Later writes time out. No vendor send or credential leak is shown. Reaper removal failures also return true without confirming success. Propagate real inspection failures, apply the deadline to every retry and release the local queue on acquisition failures. Technical reviewer has independent real-filesystem ENOTDIR and injected-EACCES reproductions exceeding 21 seconds (limit 20); source establishes repetition while the fault persists. Detailed artifacts: dispatch tree `units/605a3358/repro.test.ts`, `eacces.test.ts`, configs and logs.

2. **P2 — Copy as CLI produces an unusable tracker command when writes are granted.** `packages/web/src/lib/automation-cli.ts:89-96` exports the full trigger including access.writes, while `packages/cezar/src/automations/automation-cli.ts:238-240,304` rejects those grants on create. Root exercised actual `cliOf` and `runAutomationCommand`: generated comment grant, exit 1, zero HTTP requests. This is an exporter/CLI integration defect, not a reason to remove the deliberate CLI permission restriction. Adapt the export flow to produce a supported command and clearly tell users how to review required writes. Repro: `.ai/qa/tracker-fifth-copy-cli-repro.test.ts.txt`; `/dev/shm/tracker-fifth-copy-repro.log`.

3. **P2 release readiness — Missing required breaking-change notices.** `BACKWARD_COMPATIBILITY.md:5` requires README + CHANGELOG deprecation notice and a breaking minor release. Neither README nor CHANGELOG changed for the intentional loss of token delivery, mandatory automation-access review or encrypted-format downgrade boundary. Root verified the requirement and absence; `SDLC.md:104` explicitly supports an Unreleased section despite generated release notes. Existing detailed tracker/compatibility docs do not replace these surfaces. Add notices/release preparation; do not invent a version bump outside the maintainer release workflow. This is a shipping-policy defect, not another runtime failure.

4. **P3 — Contradictory user documentation remains.** `docs/issue-trackers.md:60` still says files are not encrypted at rest immediately after describing encrypted credential records. Lines 235–237 still say the agent fetches vendor context and this is not a server fetch, contrary to the new launch/Continue helper and later section. Distinguish encrypted credentials from unencrypted task/context data, and describe server-mediated context consistently.

## Backward compatibility assessment

| Existing scenario | Current behavior and compatibility limit |
| --- | --- |
| Managed legacy credential .env | Migrates on read, retaining UUID; encrypted record is verified before plaintext removal. Read-only storage can read legacy without migrating. |
| Legacy automation without access | Still parses and preserves state/checkpoint, but stops polling with Needs review until explicit access review. This is an intentional behavior break. |
| Existing task without issueId/access | Starts/continues with a missing-access note, without tracker commands or vendor token. Worktree work is preserved, but vendor-dependent old instructions may need adaptation. |
| Access-only automation update | Keeps scan identity/checkpoint; enabling a paused automation still uses the established current-time baseline. |
| Connection rotation/removal | Invalidates bound operations; continuation can proceed with context unavailable. Reconnect/update association is required. |
| Downgrade after credential migration | Older code cannot read .vault; documented manual reconnect is required. Stop old writers to avoid conflicts. Not transparent rollback. |
| Arbitrary vendor operations | Restricted to bound read/comment/transition; labels, assignees, attachments/custom fields and arbitrary writes are not equivalent replacements. Explicit workflow review is required. |
| Existing records and API contracts | New persisted fields remain optional; legacy/current schema round trips pass reviewer checks. Shared Zod/route-family conventions preserved. |

These deliberate limits need explicit release communication; passing parser tests does not make the entire upgrade behavior backward-compatible. No additional runtime compatibility defect beyond the integration/storage findings was confirmed.

## Evidence and limits

Root focused gate: **50 suites / 680 tests PASS**, including tracker, automation, continuation wiring, secrets, workspace migrations, route/contract/task API and child environment tests. Native current-source config `/tmp/cezar-tracker-vault-audit.vitest.mjs`, TMPDIR=/dev/shm; log `/dev/shm/tracker-fifth-review-tests.log`. Root Copy-as-CLI reproduction FAILS as above. Root also reran the technical reviewer's exact ENOTDIR test against its unchanged branch: FAIL, still waiting after 21 seconds; cleanup then allowed completion. Log `/dev/shm/tracker-fifth-root-lock-repro.log`. Diff whitespace checks pass.

Compatibility reviewer: 46 suites / 614 tests pass; direct legacy/current provenance and trigger schema round trips pass; contract typecheck passes. Technical reviewer: 27 suites / 283 tests pass, contract typecheck passes; both filesystem-fault repros fail bounded-wait assertions. Counts overlap and are not additive. Some broader reviewer tests/typechecks failed due to inherited dependencies/stale package resolution (documented in their reports); no full clean-install claim.

Latest timeout-chain, Jira read fallback and HTTP400/receipt fixes have passing regression evidence. Security inspection found no additional confirmed confidentiality issue: encrypted owner binding, capability epochs/grants, pre-send checks and unknown-outcome replay remain supported. Same-OS-user filesystem/key/control-plane trust is a documented limit.

This pass does not certify full monorepo tests, clean installation, browser e2e, native keychain acceptance or live provider operations. Earlier build/package/typecheck evidence is recorded in the fourth review and fix notes, not represented as freshly rerun here. Full reviewer reports: dispatch tree `units/49e2ba84/notes.md`, `units/605a3358/review.md`.

## Fix status — 2026-10-26

All four findings addressed locally. Lock acquisition now checks its deadline on every retry, propagates filesystem faults instead of claiming successful reaping, and releases its local queue on errors. ENOTDIR, EACCES and failed-unlink regressions prove both prompt failure and successful subsequent acquisition.

Copy as CLI exports legacy/write-enabled tracker automations as paused and read-only, with explicit editor/card and toast guidance to review the prompt and grant required writes before enabling. The original automation is unchanged; reviewed read-only exports retain their enable behavior. CLI write-grant restrictions remain intact.

README and CHANGELOG Unreleased now document the breaking upgrade, access review, narrower operations and downgrade reconnection requirement, without a manual version bump. Tracker documentation distinguishes encrypted credentials from unencrypted task data and describes server-fetched context.

Validation: four regression cases failed before changes; initial lock/export-to-CLI integration gate passed 16 tests afterward. Final server gate: 50 suites / 683 tests PASS (`/dev/shm/tracker-fifth-fix-server.log`). Web automation gate: 21 suites / 186 tests PASS (`/dev/shm/tracker-fifth-fix-web.log`). Full workspace typecheck PASS (`/dev/shm/tracker-fifth-fix-typecheck.log`); diff whitespace check PASS. The temporary cross-package integration test was removed after validation; permanent tests live in the owning packages. No fresh full-monorepo, browser, clean-install or live-provider certification. No push in this fix pass.
