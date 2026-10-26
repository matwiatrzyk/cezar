# Final full tracker-vault review — 2026-10-26

Verdict: **changes required**. Reviewed all 73 changed files in `2e16d703..30ebbc5b`, the exact implementation pushed to the fork. Two independent read-only reviewers inspected security/storage and lifecycle/business/architecture/compatibility respectively. Both branch diffs against the reviewed tip are empty. Root validated the reported issue against source, callers and independent reproductions. No production edits or push in this review.

## One confirmed finding

**P2 — Corrupt or unsafe-mode keychain account marker aborts generic secret resolution.** `packages/cezar/src/workspace/secrets.ts:113-117` throws on invalid `.keychain-account`; `loadDataKey` at :329 invokes this outside its catch, and `read` at :197 propagates it. This breaks the existing read degradation contract (empty values plus skipped-store diagnostic). `resolve` propagates into `workflows/run.ts:8143`, called before check-command spawn at :8230, so even a command not needing the damaged secret cannot start. `keyBackend` also propagates into Settings listing at `server/server.ts:6476`.

Root first reproduced malformed metadata with actual encryption and synthetic keychain, then reran the security reviewer's independent malformed/0644-marker cases: both graceful-resolution assertions fail. Three controls (12 concurrent homes and interrupted initialization before/after storing the key) pass. Sources: tree `units/root-final/marker.test.ts` and `units/6a852b13/storage-repro.test.ts`; logs `/dev/shm/tracker-final-marker.log` and `/dev/shm/tracker-final-root-storage-repro.log`. This is an availability bug, not evidence of disclosed/destroyed keys. Tracker connection inspection catches these failures; the confirmed broken path is the generic secret store and its consumers.

Correction should preserve fail-closed writes and key creation, while returning explicit unavailable/skipped diagnostics for reads and a controlled backend/list response. Never recover by silently generating a replacement key. Add regression coverage through resolve/list/backend, not only direct decryption.

## Other findings and compatibility

No other new actionable defect was confirmed. The cross-home shared-key initialization race is fixed for tested scenarios: new keys use persisted UUID accounts; legacy shared keys remain read-only, file-key precedence and moved-home identities survive. Existing receipt/queue, provider HTTP400/read fallback, Continue degradation, migration/checkpoint, write-grant/export and documentation fixes remain covered.

Compatibility reductions remain deliberate and documented: no vendor tokens in agent env, narrower operations, review required for old automations, old tasks without tracker capability, first-variant writes only, and manual recovery on downgrade to versions without encrypted/scoped-key support. Release remains subject to the breaking minor-version policy. Same-user key/filesystem/control-plane trust is still outside the isolation guarantee.

## Fresh validation

Root: **687 server tests /50 suites**, **186 web tests /21 suites**, full workspace typecheck including server build, web build and check:pack (932 files) all PASS. Diff whitespace check PASS. Logs `/dev/shm/tracker-final-server.log`, `tracker-final-web.log`, `tracker-final-typecheck.log`, `tracker-final-build-web.log`, `tracker-final-pack.log`. Current-source aliases/temporary dependency resolutions were used for tests, so these are not a clean-install gate.

Security reviewer6a852b13:435 server and186 web tests pass;3 independent storage controls pass,2 new degradation reproductions fail. Standard server typecheck encounters inherited resolution failures. Lifecycle reviewer e8175a05:680 selected server cases have passing evidence after rerunning subprocess cases with a source loader;186 web,42 core and18 convention checks pass (counts overlap). Source-aliased server/client checks pass, while ordinary checks and web source check encounter inherited dependency/export problems. Counts must not be summed across reviewers/root. Full reports and commands: tree `units/6a852b13/review.md`, `units/e8175a05/review.md`.

Limits: no fresh complete clean-install monorepo gate, packaged-CLI execution, browser e2e, real backend session, native keychain/platform acceptance or live Jira/Linear operations. Passing broad tests does not negate the reproduced marker bug. Review is complete; implementation still requires this fix before merge.

## Fix status — 2026-10-26

The marker-degradation finding is fixed. Generic read/resolve/list return an explicit skipped-key diagnostic for invalid/unreadable key metadata. Backend reporting remains available using the persisted backend hint when decryption metadata cannot be read; it is not a claim that decryption is possible. Write/key-creation paths remain strict and do not replace the key or ciphertext.

Two permanent tests (malformed and unsafe-mode marker) failed before the fix and pass afterward. They cover read, resolve, list, backend reporting, rejected writes, no fallback key creation, unchanged ciphertext/key count, and restored readability after repairing the original marker. Final validation: 704 tests /51 suites plus 10 tests /4 API/contract/CLI/redaction suites PASS; full workspace typecheck including server build PASS; diff whitespace PASS. Logs /dev/shm/tracker-marker-fix-{red,green,server,consumers,typecheck}.log. No native-keychain/live-provider/browser rerun.
