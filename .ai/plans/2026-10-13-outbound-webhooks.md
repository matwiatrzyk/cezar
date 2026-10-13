# Outbound webhooks implementation plan

> For agentic workers: execute with superpowers:executing-plans, task by task. Keep all work local.

**Goal:** Implement the complete approved project-scoped lifecycle webhook service and cockpit controls.
**Architecture:** A server-owned service observes RunStore transitions, appends bounded private sources, admits immutable deliveries under one verified owner, and sends outside its mutation queue. Node-free Zod contracts connect the service and project-only UI; graph-workflow webhooks stay independent.
**Tech stack:** TypeScript, Zod, filesystem JSON/NDJSON, Hono/SSE, React/shadcn, dedicated undici Agent.
**Spec:** `.ai/specs/2026-10-12-outbound-webhooks.md` (all sections, including appendices).

## Global constraints

- Local implementation only: no fetch, push, GitHub changes, deployment, real receiver traffic or real credentials.
- `CEZ_WEBHOOKS=1` only; off creates no service, files, capture, timers or DNS/HTTP. Headless lifecycle sends nothing.
- Retain Replay, Retry now, five receiver states, Custom events, both scopes, 0/1/3/10-minute grace, filters, M9, Activity, project SSE and both rotation modes.
- Default Minimal; fixed `cezar.json.v1`; 64 KiB bodies, 10 s HTTP total, 72 h delivery lifetime, seven-day payload retention, thirty-day bounded history.
- Outbox 50 MiB; pending 10,000 entries/50 MiB; history/activity 10 MiB each; reserve total retained bytes/objects before admission.
- One request/project, one/host, four/process; project120/min burst10; tests3/min/host/project; manual-failure10/min/project.
- Waiting/review grace180s default; failure30s and eligibility checks; readiness5s; policy/owner checks900s/15s; suspension10failures,900s probe.
- All scopes and IDs resolve through canonical project context. No global payload, secret, receiver or history cache.
- Required full gate before commits, in order: typecheck, Vitest, node unit, build, package; UI e2e before completion. Use npm11, clean task env and sandboxed home/temp.

## Review focus

1. Same-tick/clock rollback activation and compaction interleaved with sync append (tasks3–4).
2. Continue/auto-resume with delayed autosave, graph completion and stale retry dispositions (tasks2,5).
3. Copied/symlink storage, unregistered boot, unavailable ownership and deleted-history ID collisions (tasks3,6).
4. Proxy/TLS environment overrides, IPv6 transition DNS, redirect/self-port SSRF and response masking (task7).
5. Lost HTTP result, concurrent mutations/manual operation retries and retained capacity under fast terminal churn (tasks4–5).

## Tasks and interfaces

### Task 1: Domain and HTTP contracts
Files: `packages/contract/src/webhooks.ts`, `packages/contract/src/index.ts`; tests `packages/cezar/src/webhooks/contract.test.ts`.
Produce Zod-inferred `WebhookEvent`, `WebhookReceiver`, input/response schemas, event/status/profile enums and bounded typed fields. Strict mutation bodies reject project overrides. Test synthetic fixture carries no source/task/custom content.
- [ ] Write and run defaults, unknown-field, scheduled-data, bounded-text and JSON-schema tests (RED).
- [ ] Implement schemas; run `npm test -- packages/cezar/src/webhooks/contract.test.ts` and contract typecheck (GREEN).

### Task 2: Lifecycle snapshots and additive fields
Files: contract/runs.ts, runs/store.ts, workflows/run.ts, server/server.ts and new webhooks/lifecycle.ts; owning tests.
Produce optional attentionRequest/completionReason and `observeTransition(before, after, cause)` called before run notifications for update/archive/delete/prune/reconcile. Pure snapshot and freshness functions consume project identity, current run and manager readiness. No headless observer by default.
- [ ] Test question replacement, unrelated waiting, reentrant notification order, all mutation paths and off-path guard cases (RED).
- [ ] Implement central field lifetime, failure episodes and every settlement/turn-end/construction seam (GREEN).

### Task 3: Private storage and ownership
Files: webhooks/storage.ts, ownership.ts, outbox.ts; data-gitignore.ts; project-context.ts; owning tests.
Produce a canonical-root-bound private store with atomic durable writes, symlink rejection, gitignore verification, PID/start/boot lock ownership, recoverable sources/cursor/sequence and capture-gap health. Verify supported OS identity; fail service closed elsewhere. Capture append is synchronous nonthrowing; no fsync/network in observer.
- [ ] Test copied roots, tracked state, ignored boot/lazy paths, lock contention/PID reuse, truncated tail/corrupt interior, high-water recovery and append/compaction races (RED).
- [ ] Implement bounded recovery, 3-attempt compaction then30s deferral and dry-run namespace (GREEN).

### Task 4: Atomic admission and retained budgets
Files: webhooks/admission.ts, retention.ts, endpoints.ts; owning tests.
Consume sources and receiver settings; produce complete event files and frozen recipients before cursor changes. Choose finite internal budgets: retained256MiB/50,000objects with reserved control4MiB/5,000objects, bounded temporary replacement overhead; no user knob. Count retained bodies until obligations end, failure identities while episode current.
- [ ] Test first/second activation/Resume fences, equal timestamps/rollback, source append during prepare, cursor/rename crashes, empty decisions, dropped/control saturation and forty-day failure identity (RED).
- [ ] Implement admission, pruning/accounting and endpoint mutation/fence publication serialized by service (GREEN).

### Task 5: Delivery coordinator and endpoint state
Files: webhooks/service.ts, scheduler.ts, limits.ts, history.ts; owning tests.
Service exposes list/create/update/delete/activate/pause/resume/test/rotate/retry/replay/acknowledge and scoped subscribe. Test/retry/replay include operationId+expectedRevision+deliveryRevision; receipts commit atomically with effects. Network injected as `(request, signal) => Promise<TransportResult>`, outside mutation queue.
- [ ] Test every state exit, first claim/result crash, immutable failure bytes/freshness, duplicate operations, expired cooldowns, graceful overlap/revoke-now, stale claim completion and deletion history (RED).
- [ ] Implement deadlines, policy repair, probes, shared fairness, project budgets and bounded cursor pagination (GREEN).

### Task 6: Server/context integration and API
Files: server/project-context.ts, server/server.ts or webhook-family.ts, index.ts, capabilities.ts, contract/health.ts, api-client events decoder; route/contract/BC tests.
Attach service at canonical project storage with separately resolved public slug. Lightweight registry discovery never constructs managers. Pinned unregistered boot survives routine discovery. Mount one chained webhook family plus boot alias; off returns409 naming flag. SSE only project invalidation `{changeSequence}`, demand lifetime and resync.
- [ ] Test off/unavailable, A/B ID collisions, all aliases, live/history resource discriminants, no-store, typed bodies, observer attachment and removal pause failures (RED).
- [ ] Implement routes/validation, capabilities everywhere, context discovery/disposal and versioned contracts (GREEN).

### Task 7: Signing and hardened transport
Files: webhooks/signing.ts, transport.ts, address-policy.ts; core/secret-redaction.ts; dependency manifests if needed; owning tests.
`signWebhook(id, timestamp, body, secrets)` returns Standard Webhooks header; `sendWebhook` accepts url/body/headers/mode/local-consent/denied ports and AbortSignal. Resolve all DNS answers once, reject mixed classes, pin one approved IP in dedicated Agent with certificate validation and no env proxy.
- [ ] Test independent HMAC vector, rotation, address table including numeric/mapped forms, metadata/self-ports, redirected/mixed DNS, max response/time, hostile environment and redaction-off (RED).
- [ ] Implement deterministic clipping/allowlist, unconditional redaction and masked outcomes; never transmit real traffic during tests (GREEN).

### Task 8: Cockpit controls and SSE
Files: web routes/settings/webhooks*, registry.tsx, project-general.tsx, hooks/use-webhooks.ts and owning tests.
Consume shared inferred contracts; project-keyed queries and scoped SSE. Implement all M1–M11 flows and dialogs, one-time secret, native inputs, presets/custom/scope/grace, deletion history, paging/filter scope and project card. Do not modify global Notifications.
- [ ] Test off-friendly copy, secret visibility, permanent-test block/recovery, Suspended disclosure, revision conflicts, project switching/late responses, confirmation counts and two-key UI (RED).
- [ ] Implement UI and responsive/accessibility checks, no polling (GREEN).

### Task 9: Receiver guide, relay and schema
Files: packages/cezar/docs/webhooks.md, webhooks.schema.json, webhook-relay.mjs, webhook-n8n.json; webhooks/relay.test.ts.
Dependency-free relay verifies raw-body HMAC/time, serializes perID and durable store updates, records completion after successful chat. n8n template enforces supported deployment/version and the same acknowledgement semantics; use local fixtures, no live external posts.
- [ ] Test all event summaries, escaping, duplicate/concurrent IDs, failed-post retry, completion failure and restart (RED).
- [ ] Implement recipes/schema generator and regeneration equality; state trust/privacy/replay/retention/hosted limitations (GREEN).

### Task 10: Integration, compatibility and review
Files: .env.example, README.md, BACKWARD_COMPATIBILITY.md; browser e2e and final review artifacts.
- [ ] Inventory env/routes/optional fields/storage/SSE/docs and unchanged graph flag/default paths.
- [ ] Run complete gate and sandboxed browser add→test→activate→delivery plus project isolation.
- [ ] Fresh local whole-branch review; resolve correctness/security findings with red→green tests.
- [ ] Commit locally only after required checks; report location/branch/evidence and remaining risks honestly. Never push or update PR1401/issue1400.

## Execution decisions

The user approved the detailed written spec and explicitly requested local implementation. Execute inline without repeating design approval. Project-required full validation precedes every commit; task progress is recorded locally between commits. Current branch uses cached upstream42568d82, no network refresh. A final independent local review is authorized by the execution skill; do not split coupled implementation interfaces across agents.
