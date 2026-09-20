# Dashboard — verification and delivery

Behavior is specified in [Workspace dashboard](../../specs/2026-09-18-observability-dashboard.md)
and [Usage, trends and export](../../specs/2026-09-19-dashboard-costs.md).
Publication progress: [execution plan](../2026-09-20-dashboard-publication.md).

## Delivered behavior

Overview and Usage & cost provide eight sortable modules, view-scoped restore actions,
workspace-persisted preferences, task drill-downs, enabled-automation deadlines and local
PDF/CSV exports of visible modules and loaded rows. Optional reported USD/token metrics
remain independent of process telemetry. GitHub is demand-driven and distinguishes absent
configuration, stale results and failed refreshes. Operations URLs remain a compatibility path.

## Boundary and regression coverage

Service tests cover single-project scope, request guards, validated pagination, immutable
snapshots and expiry, deleted projects/tasks, policy changes during pending reads, inaccessible
or partly corrupt indexes, read-only cold-project access, forge host selection and demand limits.
Contract parity covers the consuming typed client; existing SSE payloads remain valid.

Preference tests cover unknown fields and future widget IDs through file/GET/PUT round-trips,
reorder/reset and unrelated writes. Eight supported IDs have capacity separate from the 200
future-ID budget. Cost expiry recovery retains the snapshot timezone. UI tests cover missing,
loading, failed and partial data, interactive charts, drawer navigation, filters and export scope.
Exports distinguish missing values from zero and escape spreadsheet formulas and printable text.

During publication, current main changed OpenCode's turn boundary: the runner cost stub now
emits session.idle, preserving all 18 assertions. The dashboard route also uses a lazy boundary
so unrelated screens do not import its widgets/report renderer eagerly; its guard was verified
failing before the fix. These are follow-up commits, not rewrites of published history.

## Validation

The publication gate is being rerun on the final head against upstream main 4763447f.
Results and synthetic UI evidence will be attached to the PR before readiness is declared.
An earlier full run after rebasing passed 424 files / 7447 tests; final route-loading validation
is additional. Historical local checks are not substituted for this gate.

Prior Chromium checks exercised layout persistence, keyboard reorder, mobile width, automation
schedule/check states, GitHub retries and Needs-you drawer focus restoration. Four PDF/CSV pairs
covered Overview/Usage with all or selected modules visible: 64/188/43/180 data records plus
context rows matched captured screen annotations; PDFs had 4/3/3/2 pages. A forced snapshot
expiry preserved the Europe/Warsaw cohort boundary. Those local fixture checks are historical
supporting evidence; the publication PR names the fresh checks separately.

## Material limits

- Reported usage covers retained-task lifetime values, not billing or a complete spend history.
  Task completion does not prove accepted business outcomes.
- Core RunStore's pre-existing all-or-nothing malformed-index behavior is not changed here;
  dashboard coverage now discloses it. The disk-only diagnostic reader salvages valid entries.
- Whether Claude's per-turn total_cost_usd accumulates across a continued session was not
  verified against a real provider. The dashboard displays the runner/store's existing reports
  and does not claim reconciliation with provider invoices.
- Browser evidence uses synthetic projects and controlled failures. It is not a production
  acceptance environment or a formal accessibility/security audit. Manual QA remains required.
- Preview servers, generated reports, local paths, workspace state and private project data are
  excluded from the implementation branch. Public screenshots use isolated synthetic fixtures.
