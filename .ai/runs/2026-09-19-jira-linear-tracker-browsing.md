# Implement Jira and Linear tracker browsing

Source doc: .ai/specs/2026-09-18-jira-linear-tracker-browsing.md
Design reference: #1026 (design-only; local revised spec materialized, not committed here).
Engine: om-auto-create-pr (steps: 13, --loop: no)
Status: in-progress

## Goal and scope

Implement the approved read-only tracker integration, safe paginated discovery, project association,
browsing and context-preserving agent handoff. Jira Cloud first; Linear behind the same contract.
Preserve GitHub behavior. No vendor writes, OAuth, comment/attachment ingestion or sync.

User override: LOCAL ONLY. No push, PR creation/edit/comment, labels, screenshots upload or other
publication. Keep all evidence locally. Local commits permitted. Existing linked worktree reused;
implementation branch split from locally resolved origin/main, leaving design branch untouched.

## Implementation Plan

Phase 1 (steps 1.1–1.3): contract, Jira transport/driver and tests. Gate: targeted tests and typecheck.
Phase 2 (2.1–2.4): persisted association, classification, typed routes, invalidation. Gate: route tests.
Phase 3 (3.1–3.3): project Settings, tracker UI, handoff and docs. Gate: web tests and typecheck.
Phase 4 (4.1–4.3): Linear adapter, shared scenarios, full validation and local UI evidence/review.

Validation: npm run typecheck; npm test; npm run test:unit; npm run build; npm run test:package.
UI verification separately through repository browser setup, dry-run without real credentials.

## Risks and rulings

- Live vendor-account acceptance requires separately provisioned credentials; mocked/protocol tests
  and dry-run UI evidence must not be presented as live-account verification.
- Skill remote delivery steps are superseded by explicit user no-publication instruction.
- Local skill collection resides in bare cache; git show reads it without fetch/install.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Contract and Jira driver

- [ ] 1.1 Define tracker schemas, inferred types and contract tests
- [ ] 1.2 Implement bounded Jira transport, discovery and scoped driver
- [ ] 1.3 Verify Jira failures, context conversion and dry-run fixtures

### Phase 2: Association and API

- [ ] 2.1 Persist and validate local associations
- [ ] 2.2 Wire capabilities and every project classification path
- [ ] 2.3 Chain typed API routes with parity and boundary tests
- [ ] 2.4 Reconcile caches and document route inventory

### Phase 3: Cockpit and documentation

- [ ] 3.1 Build Settings picker and tracker browse/detail flows
- [ ] 3.2 Preserve full handoff context and engine/workflow choices
- [ ] 3.3 Document configuration and verify UI regressions

### Phase 4: Linear and acceptance

- [ ] 4.1 Implement Linear protocol adapter with failure tests
- [ ] 4.2 Enable Linear and verify cross-provider isolation
- [ ] 4.3 Run full validation, review and local UI evidence
