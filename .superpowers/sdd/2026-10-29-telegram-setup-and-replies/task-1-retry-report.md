# Task 1 retry report

## Status

Done. Task 1 was reapplied to the current root base and hardened for the rejected review findings.

## Commits

- `4ae143a1b` — reapplied the Stage 1 Telegram setup orchestration.
- `1649a532e` — added durable setup recovery, durable grant capability, mode enforcement, cleanup, error mapping, and expanded tests.

## Implementation

- Setup mode is written to the durable inbound grant as `capability`; setup activation enforces the selected mode and notifications mode cannot request task-control permissions. Existing grants remain schema-compatible.
- Pending setup metadata and pairing sessions are stored atomically with `0600` permissions, reconstructed on service recreation, bounded by the existing five-minute pairing expiry, and removed after activation, cancellation, expiry, or invalid persisted state.
- Setup begin uses the pairing transaction's single `getMe` result, eliminating the rejected duplicate credential snapshot.
- Setup errors distinguish invalid token, conflict, blocked bot, vault unavailable, damaged state, mode mismatch, insufficient permission, and pairing expiry.
- Setup routes retain chained middleware validation, project scoping, flag/hosted gates, no-store behavior, and contract parity.

## Verification

- `env -u CEZ_REMOTE timeout 300 npm test -- --run packages/cezar/src/telegram/service.test.ts packages/cezar/src/server/telegram.test.ts packages/cezar/src/server/contract-parity.telegram.test.ts` — 3 files, 50 tests passed.
- `env -u CEZ_REMOTE timeout 300 npm run typecheck --workspace packages/contract` — passed.
- `env -u CEZ_REMOTE timeout 300 npm run typecheck --workspace packages/cezar` — passed.
- `git diff --check` — passed.

Coverage includes service recreation, durable activation state, activation/cancel/expiry cleanup, mode mismatch, insufficient permissions, invalid/blocked/conflicted/vault/damaged projections, hosted/flag gates, project 404/409 scope failures, activation routing, token non-reflection, and real-route contract parity.

## Concerns

- The new `capability` field is optional at the schema boundary to preserve existing stored grants. Wizard-created grants always persist it; Task 2/3 should treat an explicit `notifications` capability as a hard denial for inbound task control while retaining the existing compatibility policy for legacy grants.
