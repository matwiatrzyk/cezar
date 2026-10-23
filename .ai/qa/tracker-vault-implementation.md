# Tracker credential implementation verification

Implemented in the current worktree, without production credential access or vendor mutations.

- Managed encrypted connection records reuse the vault key/crypto, preserve connection IDs on migration, verify before plaintext deletion, and retain non-secret format markers against plaintext resurrection. Existing keychain keys are not replaced on temporary read failure.
- Agent token export was removed. Fresh server context is supplied at actual launch/continuation, with narrow read/comment/transition commands and explicit automation grants. Legacy automation migration is explicit; issue identity and connection binding are retained. Parallel variants designate one writer; parallel graph nodes share one active execution epoch, and a new epoch invalidates prior capabilities.
- Operations persist target, action, payload fingerprint and unknown outcome before sending. Completed/unknown results replay without resending. Connection and task authorization are rechecked before a write. Jira handles 204; Linear checks mutation success. Required Jira transition fields are excluded.
- This is not same-user process isolation, exactly-once delivery, or unrestricted vendor API compatibility. Attachments and custom fields remain unsupported and explicitly described. Pausing/editing automations affects future tasks; cancel current runs or disconnect to revoke current work. No live Jira/Linear acceptance tests were run.

## Evidence

- `npm run typecheck`: PASS, including prebuild, contract, API client, server and web.
- `env -u CEZ_API_URL -u CEZ_BIN npm test -- --config /tmp/cezar-tracker-vault-audit.vitest.mjs --configLoader native src/server/tracker src/automations src/workflows/agent-profile-wiring.test.ts src/workspace/secrets.test.ts src/server/contract-parity-tracker.test.ts src/server/route-parity.test.ts`: 46 suites / 597 tests PASS. After the final storage hardening, its three affected suites were rerun: 62 tests PASS, and server typecheck passed.
- UI tests (editor and tracker fields) using the temporary web Vitest config: 2 suites / 28 tests PASS.
- `npm run test:unit`: 42 tests PASS.
- `npm run build:server`: PASS; `npm run build -w @open-mercato/cezar-web -- --configLoader native`: PASS; `npm run check:pack`: PASS (929 files, 109 web artifacts).
- `npx --no-install e2e run --config .tracker-e2e.config.mts tests/tracker-access.e2e.ts --workers 1 --retries 0`: PASS. The temporary config removed the unused model declaration and used the prebuilt cockpit; no agent/model calls. Report: `.e2e/report.json`, run `01a16a49-da22-717d-87a8-7d351145cff9`. The temporary root config was removed after verification.
- Regression proof: stashed the three storage implementation files, ran the new dotenv-migration test, observed failure because no encrypted `.vault` record was written, and restored the stash. The fixed storage suites passed afterwards.
- `git diff --check`: PASS.

The inherited install pointed to a different checkout and lacked several declared dependencies. Ignored local workspace links and temporary dependency installs were used for verification; package manifests and lockfiles were not changed. Native config loading avoids the exhausted `/tmp` quota. This was targeted validation, not a claim that the full repository Vitest suite or tarball install suite was executed.
