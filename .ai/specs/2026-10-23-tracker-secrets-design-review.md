# Jira/Linear credentials: review of the vault and mediated-operations proposal

Date: 2026-10-23. Code reviewed: `2e16d703`. Status: assessment, not an implementation or an approved migration specification.

## Verdict

Encrypted storage and server-mediated tracker operations are useful, separate improvements. The earlier proposal is NOT yet a complete security design or a behavior-preserving replacement. It must not claim isolation from a shell-capable process running as the same OS user.

For this repository, prefer a managed encrypted tracker connection record, a small shared operations service, and a thin `cez tracker` CLI over the existing server. Do not introduce a new daemon, generic vendor proxy, required MCP configuration, or a second implementation of tracker clients. Keep storage migration separate from removal of agent credentials: each has different acceptance criteria.

## Evidence and missing guarantees

### 1. A localhost endpoint does not identify an authorized agent

`server/server.ts:1680–1770` protects against browser CSRF and DNS rebinding. It deliberately accepts native loopback requests without Origin. `server/origin-guard.test.ts:175` asserts this. `dispatch/task-cli.ts` uses `CEZ_API_URL`, project ID and task ID as addresses, not authentication.

Adding `/tracker/comment` with a caller-supplied run ID would let another local process impersonate that run. A scoped random bearer capability is better: bind it server-side to run, project root, source, connection revision, immutable issue ID and an operation allowlist. Reject an absent/expired capability; never take authority from request parameters or prompt text. The capability itself is a credential, but can be short-lived and much narrower than the vendor token.

This alone is still not isolation: the same local caller can reach existing management routes, create runs, edit automations and mutate settings. The agent also shares the owner's filesystem. A genuine hostile-agent boundary needs an inaccessible credential store/control plane, separate OS/container identity and restricted network/IPC access. Adding a role header or an opt-in flag that the caller can omit is not that boundary. Authentication must cover alternative paths that could mint or widen a grant.

### 2. The generic secret API is not a drop-in tracker connection store

`workspace/secrets.ts` provides per-name values, multiple caller-selectable audiences, workspace inheritance in `resolve`, and project slug/root identity. `read` returns decrypted values without an audience parameter; audiences are application routing, not OS access control. `server/server.ts:6491` exposes generic set/delete operations. `SecretStore.update` can replace a malformed file on explicit write.

`server/tracker/connections.ts` instead binds a complete credential tuple to the canonical root and fresh connection UUID. Its UUID drives association validity, cache invalidation, in-flight result rejection and automation binding. Failed replacement must preserve the old complete connection. Unregistered/moved repositories also have a credential inventory/remove CLI.

Do not turn a tracker token into an ordinary user-editable `JIRA_API_TOKEN` secret that can gain `checks` audience or be silently replaced by a workspace value. Prefer a managed namespace/record API reusing the vault's cryptography, key management and private-file discipline. Store the complete tuple and revision atomically, or use an equivalent immutable generation plus atomic pointer. The generic secret editor must not change managed tracker credentials or audiences. A `tracker` audience may document the consumer, but is not sufficient enforcement.

Preserve canonical-root ownership, offline removal and retained-record inventory even if a project is no longer registered. Encryption does not revoke a vendor token or securely erase previous backups.

### 3. Removing env credentials also removes required reads

`automations/task-template.ts:109–140` instructs an automation agent to fetch the CURRENT description, acceptance criteria, comments, status and labels, completing pagination before implementation. It permits requested write-back via direct vendor API. This is a recorded deliberate exception in `docs/superpowers/plans/2026-09-19-tracker-automation-event-parity.md`.

The current `TrackerDriver` is read-oriented and has no comment or transition operations. `jira.ts:getItem` and `linear.ts:getItem` retrieve selected fields, omit comments and cap rendered descriptions at 60,000 characters. Jira rendering can report unsupported content. The poll candidate is not the full issue.

A replacement needs fresh issue reads and paginated comments, explicit completeness/loss information, and bounded continuation when a read exceeds a request budget. Acceptance criteria in Jira may be in custom fields; the current generic description is not proof of their presence. Attachment and custom-field support must be scoped honestly, not silently promised. Never turn truncated/missing context into a successful verification. Preserve visibility restrictions and treat all returned content as untrusted data.

### 4. A comment and a status command do not equal arbitrary vendor API access

The existing prompt allows requested write-back, not an exhaustive two-operation contract. A restricted API is an intentional functional reduction for tasks that edit labels, assignees, fields or other objects. No implementation can guarantee arbitrary-prompt compatibility merely by adding comments and transitions.

Define the supported operation set and a visible migration policy for existing automations. New automations should default to read-only. Do not infer write authorization from untrusted issue content, automatically grant every old automation every write, or silently turn old working writes into failures. Existing definitions require explicit permission review where intent cannot be established structurally. This is a rollout decision, not a reason to keep hidden credential fallback forever.

### 5. Bind operations to immutable issue identity and the run lifecycle

`automations/event-source.ts` candidates include `issueId`, but `launchTrackerAutomationRun` and `runs/store.ts` currently persist key/URL without that immutable ID. `resolveTrackerAgentEnv` checks source/scope/connection before handing out env; it cannot revoke credentials already held by a running process.

A grant must use the vendor's immutable ID plus current scope validation, not just a mutable Jira key or supplied URL. Before each operation verify the bound connection, project/team membership and grant status. Define expiry/reissue for continue, restart recovery and backend switches. Rotation/removal/disconnection must stop new operations under the old binding. An already-submitted vendor write may complete and must be reconciled rather than described as undone.

Dispatch children must not automatically inherit a parent's full grant. Prefer no child writes by default; any delegation must be an explicit subset with a separate identity and audit trail. Variants should not each publish the same final comment/status: designate a writer or deduplicate at the business-operation level. Distinguish pausing future automation triggers from revoking rights of already-started runs; the UI and implementation must make that choice explicit.

### 6. Writes require their own failure semantics

Existing `TrackerHttp.json` expects JSON and its permission errors refer to read permissions. Jira transition success can return 204. A raw reuse would risk reporting an applied write as a failure. Linear GraphQL requires checking both errors and mutation success, not just HTTP 200.

The read service validates connection freshness before and after requests; after a write, rejecting a stale response cannot roll back the vendor side effect. Use a durable operation ledger, operation ID and payload hash, serialization for competing writes, bounded request deadlines and a separate `unknown outcome` state. After a timeout or crash, reconcile against vendor state before retrying. Do not promise exactly-once remote effects without a verified vendor mechanism. A local receipt alone cannot close the crash window between remote success and local persistence.

Jira workflow transitions require discovering available transitions and potentially required fields/validators; a target status ID alone is insufficient. Prevent writes from triggering uncontrolled automation loops, and define conflict behavior when a human changes the issue after the agent reads it. Audit run, issue, operation and outcome without logging credentials or arbitrary upstream error bodies.

### 7. Migration must be crash-safe and coexistence-aware

Preserve connection UUID during format-only migration; use a new UUID for credential replacement as today. Under a cross-process mutation lock, validate the old record, write the encrypted record atomically, verify it, then remove the old plaintext. Make restart at every stage idempotent. Never remove the old source on encryption/keychain failure.

Once an encrypted generation is authoritative, a corrupt/unreadable encrypted record must not silently fall back to stale plaintext. An older running cezar can otherwise recreate plaintext or race a new writer. Define supported upgrade/rollback behavior, detect conflicts and require old writers to stop before finalizing migration. Do not claim atomicity across independently mutable secret and metadata files.

No keychain must remain a supported default with clearly reported file-key fallback. A temporarily locked existing keychain must not cause destructive replacement of an established encryption key. Test missing key, corrupt ciphertext, read-only home and removal after migration; never probe real user credentials for those tests.

## Recommended shape and rollout

| Approach | What it achieves | Main cost/limit |
| --- | --- | --- |
| Encrypt managed tracker records only | Better storage hygiene, existing behavior preserved | Agent still receives vendor token |
| Encrypted records + mediated typed operations | No intentional vendor-token delivery; narrower audited actions | New reads/writes, lifecycle, authorization and compatibility work; same-user bypass remains |
| Above + isolated agent runtime/control plane | Enforceable boundary against a hostile task process | Cross-platform runtime/network/filesystem work beyond a tracker migration |

1. Specify threat model, exact supported operations and old-automation transition policy first. Separate storage-at-rest, accidental exposure reduction and hostile-agent isolation in claims.
2. Implement encrypted managed records with migration and unchanged connection semantics. This can ship independently, explicitly without claiming removal of agent access.
3. Implement `TrackerOperations` using existing provider/source validation and transport discipline. Expose a thin CLI through the existing cockpit server, adding authorization for the new operation channel; per-run capabilities must not be merely run IDs. MCP can be a later adapter over the SAME service, not the primary transport: private MCP is not supported by every current backend (`core/private-mcp.ts:48`). For headless/no-server execution return an explicit unavailable result; do not fall back to exporting tokens.
4. Complete reads, supported writes, permission setup, lifecycle/recovery and durable operation outcomes. Keep management authority distinct from task authority; describe remaining same-user limitations accurately.
5. Switch automation prompts and all launch/continue paths to those operations. Remove `resolveTrackerAgentEnv` delivery only after replacement coverage and old-automation handling are verified. No silent legacy credential fallback.

A constrained CLI is the simplest backend-independent interface in this repository, not an assertion that it is a sandbox. Full isolation is a separate architectural decision. Do not add generic REST/GraphQL execution to make a narrow interface appear complete.

## Acceptance matrix before implementation can be called complete

- Synthetic token absent from agent env, prompts, process arguments, events, reports, error bodies and child tasks; tracker-only values absent from checks and workspace fallback.
- Missing/forged/expired/wrong-project/wrong-run grant rejected; changing IDs, CLI arguments, Origin or a request's claimed role cannot widen authority. Explicitly test management-route bypass if claiming isolation.
- Root vs slug reuse, unregistered inventory, move, delete, rotation, disconnect, failed replacement, concurrent writers and old-version coexistence retain documented behavior.
- Crash injection before/after every migration commit point; locked/missing keychain, no native package, corrupt files and read-only home; no plaintext resurrection after authoritative migration.
- Fresh issue body, all accessible comment pages, explicit truncation/unsupported fields, issue move/rename and cross-scope denial.
- Jira ADF comments, transition metadata/required fields and 204; Linear partial GraphQL errors/success=false; no fabricated parity between vendor workflows.
- Timeout after remote acceptance, retry after crash, repeated operation ID with different payload, concurrent variants and human edits; unknown outcome never silently retried as a fresh write.
- Queue/start, continue, restart, backend switch, terminal run, revocation, child delegation and disabled automation semantics.
- Existing automation use cases either still work through the new path or receive an explicit migration action; no background write enabled merely by migrating storage.
- Contract parity, all supported backend launch paths, dry-run with no real secrets/network, and packaging/headless behavior. Mock tests establish implementation behavior, not real vendor or OS isolation guarantees.

## Second pass (same day): is the `cez tracker` stage optimal?

No. It pays the full cost of an agent→server authorization channel (per-run capabilities, ledger, unknown outcomes, lifecycle) for a boundary it cannot hold:

- The data key is reachable by any same-user process: `secret-keyring.ts` reads it through `@napi-rs/keyring` (Secret Service on Linux; on macOS the item trusts the `node` binary the agent can also run), else `~/.cezar/secrets/.key`. An agent with unrestricted `Bash` can decrypt the stored token in a few commands. Removing it from env stops accidental use and the trivial `env` exfiltration path, not a determined or injected agent.
- So the only control an agent cannot bypass today is the token's own vendor-side permission set.

Cheaper design with the same practical benefit and fewer new failure modes:

1. **Encrypt at rest** (stage 1 above, unchanged).
2. **No live agent access to the tracker.** At launch (and on continue) cezar fetches the full issue — paginated comments, explicit truncation markers — server-side and hands it to the agent as an untrusted attachment. The agent never needs a token to read.
3. **Writes are cezar actions, not agent calls.** Declarative per-automation actions (`onLaunch: transition`, `onReview: comment with summary/PR link`) and the agent's proposed comment as a run artifact, posted when the user approves at the review gate (or automatically only if the automation opts in). The authority comes from the cockpit/user, which is already the trusted control plane, so no per-run capability, no forged-runId problem, no child-task delegation, and idempotency reduces to one recorded action per run.
4. **Least-privilege tokens.** Settings recommends (and where the vendor exposes it, displays) the token's permissions: read-only suffices for polling and snapshots; write only if write actions are configured. Linear API keys support permission and team restrictions. Atlassian scoped API tokens should be verified against the current transport — they are believed to require the `api.atlassian.com/ex/jira/<cloudId>` gateway rather than the site origin `jira.ts` uses (unverified in this pass; web search was unavailable).
5. Remove `resolveTrackerAgentEnv` once 2–3 cover existing automations; existing automations whose prompts ask for write-back get an explicit migration notice.

Lost versus today: mid-run ad-hoc tracker reads (linked issues, other tickets) and arbitrary writes. These are the same reductions the CLI stage would impose; the snapshot can include direct links one level deep if needed.

Still required from the original review: crash-safe migration (§7), connection identity/revision (§2), Jira 204 and Linear `success=false` handling (§6, now on a server-side path only), immutable issue ID on the run record (§5).

## Vendor documentation checked

- [Jira issues/transitions](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/): transitions and transition fields are distinct from generic edits.
- [Jira comments](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/): pagination, visibility permissions and ADF comment bodies.
- [Linear GraphQL](https://linear.app/developers/graphql): state updates and partial errors despite HTTP 200.
- [Linear API key permissions](https://linear.app/docs/api-and-webhooks): permissions and team restrictions can limit the underlying key independently of cezar policy.

No live vendor writes or real credential reads were performed. This review validates the gaps and the recommended direction; the proposed new authorization, migration and write paths do not exist yet and cannot be certified by existing tests.

## Local verification

The inherited installation resolves `@open-mercato/cezar-contract` to the main checkout, not this worktree. That explains the earlier `stepSecretsSchema` undefined import. No repository dependency files or shared installation were changed. A temporary Vitest configuration at `/tmp/cezar-tracker-vault-audit.vitest.mjs` aliases contract/client to this worktree. Missing `dotenv` and `proper-lockfile` were installed with scripts disabled under `/tmp/cezar-tracker-audit-deps`, using versions from this worktree's lockfile, and aliased there.

Command:

```sh
npm test -- --config /tmp/cezar-tracker-vault-audit.vitest.mjs src/server/tracker src/workspace/secrets.test.ts src/workflows/secrets.test.ts src/workflows/agent-profile-wiring.test.ts src/automations/task-template.test.ts src/server/origin-guard.test.ts
```

Result: 24 suites, 317 tests: 316 passed, one environment-sensitive failure in `agent-profile-wiring.test.ts` because this cockpit session exports `CEZ_API_URL` and `CEZ_BIN`. The failing suite passed all 11 tests when rerun without those two inherited variables:

```sh
env -u CEZ_API_URL -u CEZ_BIN npm test -- --config /tmp/cezar-tracker-vault-audit.vitest.mjs src/workflows/agent-profile-wiring.test.ts
```

Thus all 317 selected tests have passing evidence, across the main run and the isolated rerun; this is not a claim that the unmodified repository-wide command passes. The passing suites include current tracker adapters, credential binding/isolation, API routes, automation templates, vault behavior, workflow secret delivery and the origin guard. No production implementation was changed; no full build, browser test or live vendor acceptance test was performed.
