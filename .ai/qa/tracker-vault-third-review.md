# Tracker vault: third full review

Verdict: **changes required before merge**. Scope: entire implementation diff `2e16d703..4c2c1618` (58 files including prior review artifacts), plus root verification. Three independent read-only reviews: a5ee3842 security/storage, 293fc8e5 architecture/conventions, 8039a13b business/lifecycle. All complete; reviewer branch diffs against reviewed tip empty. No production edits or merges.

## Confirmed findings

1. **P2 — Timeout defeats issue-write serialization.** `packages/cezar/src/server/tracker/task-access.ts:106-109`. A holds the lock; B waits 20 seconds then times out. B deletes the map entry while A remains active. C sees no queue and reaps A's live same-PID disk lock, entering the provider concurrently. Adapter context reads allow 30 seconds, so the timeout is reachable during normal bounded work. Root and two independent reviewers reproduced maximum concurrency 2 instead of 1 using real timers/filesystem. Preserve the predecessor chain until it settles, including cancelled waiters; cover timeout followed by a third caller. This establishes overlapping distinct operations, not a proven duplicate send for the same receipt ID. Root reproduction: `.ai/qa/tracker-review-timeout.test.ts.txt`; output `/dev/shm/tracker-third-review-repro.log` (1 failed, 20.52s).

2. **P2 — Cold Jira list/search loses site-token fallback.** `packages/cezar/src/server/tracker/jira.ts:209` suppresses authentication fallback for every POST, including the read-only `/rest/api/3/search/jql` used by `readItems`. A fresh client whose gateway rejects valid site credentials returns unavailable/unauthorized without trying the site. Keep the no-retry policy for mutations, but distinguish read-only JQL requests. Root reran the reviewer's exact baseline/current test: baseline 2 passed, current 2 failed (gateway 401 and 403), with requested URLs proving no site fallback. Artifact: dispatch tree `units/8039a13b/review-repro.test.ts`; root log `/dev/shm/tracker-third-review-jira-repro.log`. Do not generalize to all automation polls: polling first calls GET /myself, which normally selects site transport.

3. **P3 — Provider extension guide contradicts the new storage design.** `docs/adding-issue-tracker.md:70-75` still prescribes managed dotenv storage and forbids migrations/removal tombstones. The implementation now uses `.vault` plus `.migrated`, with dotenv as legacy input. AGENTS directs integration authors to this guide first. Root checked the text. Update schema/legacy-codec guidance and describe the managed encrypted store. Documentation defect, not a separate runtime blocker.

## Assessment across requested dimensions

- Technical/business: the two reproduced runtime regressions prevent approval. Legacy Continue degradation, explicit automation access migration, checkpoint preservation, variant grants, bounded context files, pre-send rejection and unknown-outcome receipts have source/test support.
- Architecture/conventions: shared Zod contracts, chained middleware-validated project route families, launch/Continue helper, backend env seam and package contract export follow repository structure. Custom lock cancellation remains incorrect; extension guide is stale.
- Security/storage: no additional evidenced critical credential leak. Vendor tokens are no longer deliberately delivered to agents; capabilities bind to project/run epoch and active status. Encryption namespace/identity binding, UUID-preserving migration, corrupt-ciphertext refusal, size bound and post-rename reconciliation reviewed. Same-OS-user file/key/control-plane access remains an explicit trust limitation, not isolation.

## Verification and limits

Root: 47 focused suites / **616 tests passed**, using `/tmp/cezar-tracker-vault-audit.vitest.mjs` with current-source aliases and TMPDIR=/dev/shm; `npm run typecheck` **passed**, including its server prebuild; `git diff --check 2e16d703 HEAD` passed. Logs: `/dev/shm/tracker-third-review-tests.log`, `/dev/shm/tracker-third-review-typecheck.log`. Root's new timeout regression fails, as do the two current-Jira challenge cases; existing green tests do not cover these paths.

Reviewers independently ran focused server and 28 web component tests; counts overlap and are not additive. Some broader reviewer runs/typechecks failed due to inherited stale workspace links and subprocess dependency resolution (proper-lockfile); these are recorded as failed checks, not silently discounted or attributed to this patch. Full clean-install suite, full web build/package gate, browser e2e, actual agent sessions, native keychain acceptance and live Jira/Linear writes were not certified by this review.

Detailed reports and reproductions: dispatch tree `units/a5ee3842/review.md`, `units/293fc8e5/review.md`, `units/8039a13b/review.md`. Review complete; implementation needs the above corrections. No push or PR.
