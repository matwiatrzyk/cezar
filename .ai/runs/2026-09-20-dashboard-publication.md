# Publish the workspace dashboard

Source doc: .ai/specs/2026-09-18-observability-dashboard.md
Companion spec: .ai/specs/2026-09-19-dashboard-costs.md

## Goal

Publish the already implemented dashboard as one reviewed PR with current-base validation and safe UI evidence.

## Scope

Reuse the existing isolated `cez/38d87773` worktree and implementation commits. Preserve the service, cockpit, documentation and regression-fix split. Rebase the unpublished history onto the upstream default branch and resolve documentation relocation. This is publication of completed local work, not a new implementation; the execution plan therefore follows the existing code commits.

## Non-goals

No merge, deployment, new integrations, billing estimates, unrelated refactoring or publication of local workspace state. Preview harnesses, generated exports and real project data remain ignored and unpublished. Only synthetic, inspected UI evidence may be uploaded separately.

## Implementation Plan

### Phase 1: Prepare the existing implementation

1.1 Verify the publication target, reuse guard and current base; preserve clean commits.
1.2 Refresh delivery documentation and run the configured validation gate.

### Phase 2: Review and publish

2.1 Open one draft PR, run om-auto-review-pr and address actionable findings.
2.2 Verify representative UI flows, attach synthetic evidence, report validation and promote to ready.

## Risks and limits

Shared workspace/API surfaces and reported costs require boundary tests. Retained-task usage is not billing and task completion is not business acceptance. Historical cost and task-index limitations are documented in the delivery report. Manual QA remains required. GitHub does not allow author self-approval; an automated review comment is evidence, not an independent maintainer approval.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Prepare the existing implementation

- [x] 1.1 Verify the publication target, reuse guard and current base; preserve clean commits. — f839acf0
- [ ] 1.2 Refresh delivery documentation and run the configured validation gate.

### Phase 2: Review and publish

- [ ] 2.1 Open one draft PR, run om-auto-review-pr and address actionable findings.
- [ ] 2.2 Verify representative UI flows, attach synthetic evidence, report validation and promote to ready.
