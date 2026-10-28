# Telegram inbound — implementation evidence

Base: 87220095bfd78fe3fec5410468f3c893f7ac2cd0. Stage 1 in progress; stage 2 not started.

## Stage 1 preparation

- Read handoff, full spec rev6, repository instructions and e2e skill.
- Council resolved bootstrap revision and Connect arbitration; decisions in spec §16.
- Extracting message delivery without changing HTTP receipts or semantics.
- Baseline full suite running: /tmp/telegram-inbound-baseline.log. Targeted extraction: 55 passed, two provider-action-gating failures also observed in baseline; final baseline comparison pending.

## Stage 1 five iterations

Pending implementation. No iteration claimed complete.

## Stage 2 five iterations

Not started.

## Foundation checkpoint (not completion of stage 1)

Implemented locally, no commit/push:
- `server/run-messages.ts`: pure delivery ladder extraction; HTTP receipts remain in handler. Optional synchronous beforeEffect for adapter after async provider gate; HTTP leaves it absent.
- `telegram/state.ts`: bounded 2 MiB reads, single serialized writer, durable claimed/recovery/offset/epoch, capacities and compaction.
- `telegram/ownership.ts`: reused process lease, permanent project/root/install binding, short unbound Connect lease helper, cleanup-handle preservation.
- `telegram/protocol.ts`: strict IDs, human-text filtering, command entities/suffix parsing, date bounds, unique task-prefix resolution.
- `telegram/client.ts`: fixed Telegram transport, pinned DNS, cancellation/deadline/body cap, safe errors, dry-run refuses real network.
- `telegram/poller.ts`: single sequential loop, durable offsets, recovery/probing, 429/backoff/oversized-body fallback, stop and diagnostics.
- `telegram/pairing.ts`: hashed memory-only private pairing codes/candidate/TTL/project cap.
- `telegram/dispatcher.ts`: ephemeral bounded replies with retries/TTL/grant recheck and per-user/bot command limiter.
- `telegram/authorization.ts`: receiver/grant/credential generations and correlation freshness.
- `contract/telegram.ts`: initial route schemas; no HTTP routes or UI wired yet.
- `webhooks/transport.ts`: bounded success-body parsing retains only verified message/chat IDs in WeakMap through telegramReceipt(result); wire diagnostics unchanged. Service must capture receipt BEFORE redactWebhookDiagnostics reconstructs result.

Evidence:
- 100/100 checkpoint tests (11 files) pass, `/tmp/telegram-foundation-checkpoint.log`.
- 41/41 foundation+authorization tests pass, `/tmp/telegram-authorization-tests.log`.
- Full typecheck passed before last authorization additions; final checkpoint rerun scheduled.
- Receipt regression red without parser, green with it (`/tmp/telegram-receipt-red.log`, `-green.log`).
- Grant revoke race regression red with beforeEffect removed, green restored (`/tmp/telegram-grant-red.log`, `-green.log`).
- Initial full test: 12822 passed, 7 failed (4 create-project, 2 provider-action-gating, 1 markdown-mermaid).
- Targeted baseline comparison restores server.ts+transport.ts from exact 87220095 during test then restores working changes in finally; `/tmp/telegram-exact-baseline-failures.log`. Inspect its summary before reporting baseline status. No baseline files left swapped.

NEXT (stage 1 still incomplete):
1. Read checkpoint full typecheck/test output. Do not count foundation checks as five post-stage iterations.
2. Implement project TelegramInbound orchestrator integrating lease/state/pairings/poller/dispatcher and authenticated task commands; bounded lazy project context, full API operations/revisions/activity/reset/disconnect/orphan bindings. API error/status contracts must match routes exactly.
3. Wire service/coordinator/server startup and shutdown, Connect arbiter (even flag off), outbound receipt correlation and narrow episode freshness read; no new lifecycle observer. Add CEZ_CHAT_INBOUND only with .env.example/docs/reference docs.
4. API chained family/scoped parity, WebSocket invalidation (generic no data), settings UI and harness/e2e, docs.
5. Complete all stage1 scenarios THEN five explicit test/fix rounds, record results, only then stage2. Stage2 adds groups/cancel/continue confirmation and its five rounds.

Known implementation care points: no runtime module is yet polling; no real bot calls. State root/install/generation must be validated by orchestrator before grant access. Never boot networking from GET. Poller fatal states must persist disable through orchestrator; current callbacks only report health. Grace=180 unchanged. Stage2 schemas available but behavior not implemented. No commit requested/created.

## Continuation: conversation and Connect integration

- Previous checkpoint completed: full typecheck passed; full suite 12869 passed / 6 failures, the same 4 create-project + 2 provider-action-gating confirmed against base. No new failure. Log `/tmp/telegram-inbound-checkpoint-tests.log`.
- Added `conversation.ts`: text Reply and commands, bounded lazy context, grant checks after recovery and provider gate, durable claim/result, no ambiguous retries, escaped/redacted status and tasks, status reply correlation.
- Added `connect-arbiter.ts`, wired existing `webhooks/telegram-connect.ts` + service projectRoot: local owner cache or short disk lease; inactive durable binding rejects. Independent of inbound flag.
- Added `connect-cache.ts`: bounded metadata-only configuration sessions distinct from authorization pairings.
- Added `runtime.ts`: composes lease/state, own getMe, poller, private pairing, conversation, replies, Connect registration and shutdown. NOT YET constructed from WebhookService/coordinator. Project configuration/API/UI still missing.
- Tests written against stubs then red/green: conversation 9, arbiter 3, cache 2, runtime 1. Logs `/tmp/telegram-conversation-{red,green}.log`, `/tmp/telegram-arbiter-{red,green}.log`, `/tmp/telegram-connect-cache-red.log`, `/tmp/telegram-runtime-{red,green}.log`.
- 81 tests passed for conversation+foundations+existing Telegram/Connect before runtime; runtime integration test also passed. Server typecheck then caught `options.dryRun === true` after dry-run early-return; changed to false. Rerun pending.

Next priority: project TelegramInbound controller/config lifecycle (load/save/revisions, pair/confirm/revoke/enable/reset/disconnect, state identity validation), instantiate runtime from service/coordinator and pass own project context/shared delivery from server; outbound receipt correlation; HTTP routes, UI, invalidation, docs/flag and e2e. Then all five stage1 rounds; do not start stage2 prematurely.

Review TODOs to cover in stage1: runtime shutdown during getMe must abort and retain lease until startup settles; drain state writes before releasing lease; throttle wrong-chat pairing notices once/minute; `/tasks` must never clip a partially rendered ID when escaping expands output; distinguish byte/UTF16 text length for /reply; Connect cache group/channel metadata in stage2. These are unfinished details, not accepted deviations.

## Controller checkpoint

- Prior broad checkpoint: `/tmp/telegram-bridge-checkpoint-types.log` passed; `/tmp/telegram-bridge-checkpoint-tests.log`: 12884 passed, six confirmed baseline failures.
- Added `telegram/service.ts` configuration controller + five tests: bootstrap revisions, pairing/confirmation, revoke, disable/re-enable/reset/disconnect; passive list, durable bot leases, runtime lifecycle, activity. NOT yet wired into production service/routes/UI.
- Full typecheck of controller passed `/tmp/telegram-controller-types.log`.
- Runtime shutdown now aborts getMe and waits startup, poller/replies/state writes; controller retains lease. Regression red `/tmp/telegram-startup-red.log`, green targeted suite. Conversation final grant check also rejects when runtime closes.
- Disconnect removes reset state under lease, allowing fresh explicit pairing without restoring grants. Regression red `/tmp/telegram-disconnect-red.log`.
- Latest targeted validation: 73 tests,14 files passed `/tmp/telegram-controller-final.log`; diff check clean.
- Council approved lightweight Telegram route family before shared context resolver. GET must not start poller indirectly via coordinator.get/service.start. Decision appended to spec.
- Remaining controller issues: corrupt-state/reset/orphan-binding APIs; reconnect after crash between disconnect and state removal; runtime.run fatal-state restart/overlapping startup; wrong-chat notification throttle; changes to receiver chat/bot. See previous continuation TODOs.
- Next: wire controller to WebhookService/coordinator, outbound correlation, lightweight API family, UI/subscriptions and docs; finish stage1 then its FIVE rounds. No rounds complete, stage2 unstarted.

## Production wiring checkpoint

- Final controller typecheck passed. Added outbound correlation storage with installation/project/chat/revision/generation checks.
- `WebhookService` now owns TelegramInbound, loads passive configuration, resolves vault token per call, correlates receipts before diagnostic redaction loses WeakMap identity, and disposes inbound. Injected fake transport in tests; no live network.
- Separate `startTelegram()` lifecycle: coordinator discovery calls it, passive get/outbound.start does not. Lazy authorized context/delivery callbacks wired from server, preserving single-project/root checks and shared account gate.
- Added `server/telegram.ts` chained family mounted before shared heavy project resolver. Root/registry-only scope, flags, no-store, commands/config routes, no unknown-path fallback to RunManager. Workspace orphan routes still pending.
- New runtime route tests and production createApp tests pin no context recovery/polling, three aliases, single-project denial. Route parity and typed bodies unchanged: 12/12 pass `/tmp/telegram-scope-parity.log`; foundation/service/coordinator 121/121 `/tmp/telegram-lifecycle-green.log`; API family/controller checkpoint17/17.
- Added contract-parity.telegram compile-time assertions; full API typecheck passed `/tmp/telegram-api-types.log` before last new tests, latest server parity typecheck `/tmp/telegram-api-parity-types.log` inspect final status.
- RecordDelivery, passive service lifecycle and coordinator seams have failing-before/passing-after tests. See `/tmp/telegram-correlation-red.log`, `/tmp/telegram-service-wiring-red.log`, `/tmp/telegram-coordinator-red.log`.
- Scope test initially mounted Hono aliases in wrong order; corrected to real server scoped-first order, all pass. Keep real mount order.
- Remaining: UI/subscription topic, orphan bindings + corrupt-state/reset behavior, runtime restart/start concurrency, throttled wrong-chat notices, changed bot/chat re-pair, feature docs/E2E, final review. No stage complete; no five acceptance rounds started. Stage2 unstarted.

## UI + subscription checkpoint

- Full wired checkpoint: typecheck passed; 12895 pass/9 fail. Three new failures were incomplete WebhookCoordinator mocks in projects-api.test.ts (missing setter); fixed fixture only, existing behavior assertions unchanged. That suite now 51/51. Six remaining failures are established baseline.
- Coordinator generic onTelegramChange, server demand-scoped WS telegram-inbound topic `{changed:true}` only, contract invalidation schema. Subscription test red then green (10/10 coordinator). Server snapshot must be async per hub interface; fixed typecheck failure.
- API client telegramApi methods; use-telegram hook invalidates all project Telegram queries on generic bus event, unsubscribe on unmount. UI subscribes only after available=true (no hosted socket).
- New TelegramInboundPanel mounted in webhook settings only for Telegram receivers, expanded on demand. Flag explanation, dedicated-bot consent, private pairing/link/candidate explicit approval, revoke, disable/re-enable, status refresh, activity, bot reset/disconnect confirmation. Query/mutation scope explicit; late response guarded on unmount.
- 123 tests/13 files passed `/tmp/telegram-ui-checkpoint.log` including 4 new UI tests and existing webhook panel/hooks. Full typecheck passed `/tmp/telegram-ui-types.log` before last dialog edits; final web typecheck `/tmp/telegram-ui-final-types.log`.
- Council decision for orphan routes: dedicated exact workspace family mounted before project v1 (global guard remains); GET bounded diagnostic binding read without lease, DELETE lock+reread+orphan+revision recheck. In spec; not implemented yet.
- STILL incomplete: orphan APIs/UI, corrupt state recovery/reset, runtime concurrency/fatal restart, changed bot/chat pairing, wrong-chat throttling, E2E/browser coverage, docs/site and manual UX review. Five post-stage rounds remain zero; stage2 not begun.

## Orphan binding checkpoint

- UI build+check:pack passed (`/tmp/telegram-ui-build.log`:1148 files).
- Added `telegram/bindings.ts`: passive bounded no-follow/Zod binding reads, visibleProject filter, 100 row/1000 scanned cap with truncated flag, hashed revision; release gates flags/local, obtains lease, rereads revision+orphan status, refuses live owner/restored project. GET creates no files.
- Added exact workspace family `server/telegram-bindings.ts`, mounted before project v1 catchall behind global guard. Scoped binding paths404 without manager. Schema+response type parity added.
- UI diagnostics is on demand, lists bot/project/orphan state only; explicit confirm release. Panel now available even with no Telegram receivers (for orphan recovery). Added API client methods.
- Tests: bindings3 + UI5 pass `/tmp/telegram-orphan-final.log`; bindings/scope/alias13 pass `/tmp/telegram-bindings-routes.log`; full typecheck passed `/tmp/telegram-bindings-types.log` before last UI/tests. Prior UI17 passed.
- Added user docs section to packages/cezar/docs/webhooks.md and API BC entry. docs/site still pending.
- Council resolved corrupt/missing state reset (spec appended): own durable binding discovery, full file hash (stream bounded memory/time if oversized), no partial grant salvage, explicit reset under lease after runtime/writer drain and revision recheck. Not implemented yet. Need schema representation of blocked bot without reset revision until hash ready.
- Remaining priority: corrupt/missing reset, state failures surfaced not swallowed, runtime concurrent/fatal restart and re-pair changed bot/chat; wrong-chat limiter; docs/site; E2E; stage1 FIVE rounds still all pending, stage2 unstarted.

## Damaged-state recovery checkpoint

- Prior orphan checkpoint passed full typecheck and 690 tests/72 files.
- Added recovery.ts streaming full-file fingerprint, binding+missing marker, 64KiB buffer, 5s checked deadline, no-follow/nonblock regular file check, mutation metadata detection. Two tests; red stub then green. Caveat to review: pending individual filesystem read is not abortable by checked deadline; full per-operation wall-clock bound may need stream AbortSignal.
- TelegramInbound discovers own durable bindings even if state missing; damaged states exposed blocked with OPTIONAL bot inboundRevision (absent if no safe full hash). No grants salvaged. refreshDiagnostics updates hash on passive GET and detects a live state store blocked by write failure.
- Explicit damaged reset acquires/reuses own lease, drains/stops existing runtime, cancels existing pairing sessions, rehashes under lock, atomically publishes fresh disabled state without grants, keeps binding. tracks resets for disposal. Failure retains bytes. Optional revision disables UI reset/disconnect with explanation.
- New tests missing/corrupt/oversized, changed bytes + refresh, live writer failure reset, overlapping lifecycle startup. 76 backend integration passed before last startup edits; latest19 controller/runtime/UI passed `/tmp/telegram-recovery-final.log`. Full typecheck passed `/tmp/telegram-damaged-types.log` before last refresh/runtime edits.
- startBot is coalesced with Bot.starting; fatal stopped runtime can be recreated, requires completed shutdown. Runtime final grant activity checks flag availability, wrong-chat pairing notices limited once/min/chat with bounded1000 map. Need dedicated flag/throttle tests in acceptance.
- Added docs/site telegram-replies.mdx (auto navigation meta has title only); primary docs added in earlier turn.
- Remaining before stage1 completion: changed bot/chat re-pair workflow (currently reset workaround/possible old binding confusion); receipt/status/prose freshness review; browser/E2E scenarios; capacity/failure/flag/throttle tests; queued response text limits and startup/maintenance race review; docs consistency. FIVE acceptance rounds after complete stage1 still zero. Stage2 unstarted.

## Re-pair and first browser flow

- Prior recovery checkpoint full typecheck +698 tests passed.
- Explicit replaceExisting:true pairing; samebot clears only receiver grants/correlations/generation. Changedbot first getMe discovers target, stores transient replacements map and returns409 BEFORE mutation. receiverRevision combines old+target states; repeat revalidates both, retires oldreceiver and creates disablednewreceiver. Keeps oldbot assignment/otherreceivers. UI explicit revoke-access warning/button requires dedicated consent. Council decision in spec.
- Tests red2 then green14; stronger confirmed-grant preflight test proves409 retains old grant, second call clears it. Logs `/tmp/telegram-repair-red.log`, `-green.log`, `-confirmed.log` (19 controller+UI). Full typecheck passed `/tmp/telegram-repair-types.log` before final preset fix.
- Added test-only coordinator telegramCall injection and e2e fixture server with fake provider, dryrun, temporaryhome/repo. Real server+WS+UI; Pairings.create wrapper queues synthetic Start update; no production impersonation route.
- First browser failure found REAL BUG: default attention preset has events:[], but receiverEligible and UI required events.includes. Added regression red (`/tmp/telegram-presets-red.log`), fixed both to recognize attention/all; 11 unit/UI pass. E2E rerun PASS `/tmp/telegram-e2e-retry.log`, report under packages/web/e2e/.e2e/telegram-inbound/. No fixture process remains.
- New files `telegram-inbound.config.ts`, `.e2e.ts`, `-server.mjs`; spec currently names telegram-bidirectional.config.ts, align name or spec before acceptance. Browser test: dedicated consent, auto simulated Start, explicitapprove, disable, revoke, diagnostics. Does NOT yet cover full question→reply→nextquestion scenario or restart UI.
- E2E uses existing repo skill (read setup/running/writing topics). No AI agent steps/auth/network needed. Build:web passes.
- NEXT: finish stage1 mandatory scenario coverage (full outbound→Reply integration, security/stale/race/capacity matrix), full docs reconciliation (site skill still to read), then explicitly five post-stage iterations. Still ZERO rounds and stage2 not started. Do not count these foundation runs as rounds.

## Full conversation integration checkpoint

- Found prior checkpoint typecheck failure: UI test fixture was an incomplete WebhookReceiver assertion. Replaced with complete typed fixture, ISO timestamps.
- Added `telegram/roundtrip.test.ts`: real WebhookService + RunStore + transport receipt parsing (mocked undici) + vault + inbound controller/poller + real deliverUserMessage/provider gate with stub engine sink. Pairing update goes through poller; notification lifecycle captured; Reply forwards `[via Telegram]`; durable accepted journal; next episode rejects old Reply and accepts new. Parameterized structured/prose questions. Uses only fake network/token. Both pass.
- Added real UI audit pagination via useInfiniteQuery and API cursor, red/green test. 7 targeted tests pass `/tmp/telegram-roundtrip-pagination.log`; later full targeted 704/704 in74files `/tmp/telegram-roundtrip-checkpoint.log` includes both roundtrip variants.
- Added runtime flag-off test: pendingpoll aborted, grant preserved, no context/delivery. Controller15/15 `/tmp/telegram-flag-runtime.log`.
- Aligned spec E2E config name to actual telegram-inbound.config.ts. Read/applied cezar-docs skill, updated page structure/sources. sources omit commit because files uncommitted, avoid false attribution. Direct docs checker passes204pages `/tmp/telegram-docs-direct.log`. Root docs:check wrapper failed npm EALLOWSCRIPTS --prefix install; safe cwd install with --ignore-scripts succeeded456 packages, no tracked lockchange. Docs build now pending.
- Pending full typecheck `/tmp/telegram-roundtrip-types2.log` session18490 and docs build `/tmp/telegram-docs-build.log` session38703. No livebot/no commit/push. git diffcheck clean. Stage1 still incomplete; five poststage rounds ZERO, stage2 unstarted. Next audit remaining A-H coverage (capacity, writefail interleavings, wrongchat reply throttle, reboot/capturegap), review reset read deadline and replacementfailurebetweenwrites, then stage1 five rounds.

- Docs site build PASS `/tmp/telegram-docs-build.log`. Full typecheck2 server/contract/client pass, web failed infinitequery unknown-page inference; reordered queryFn before getNextPageParam as existing webhooks history. Focusedwebtypecheck pending exec51166 `/tmp/telegram-pagination-types.log`.

## Stage 1 safety completion and validation round 1

- Focused webtypecheck passed after infinitequery propertyorder fix.
- FIFO state regression: red child-process timeout `/tmp/telegram-fifo-red.log`, fixed O_NONBLOCK+regularfile check; green10tests `/tmp/telegram-fifo-green.log`.
- Capacity regression: old compaction reserialized 2MiB on every eviction, failed after21s `/tmp/telegram-capacity.log`. Linear byte accounting fixes;13tests in1s `/tmp/telegram-capacity-green.log`. Preserves claimed/grants while evicting oldest correlations. Added failedrecovery retry and probingrestart tests.
- Runtime wrong-chat doubleStart receives one notice and no taskcontext;16state/runtime green `/tmp/telegram-safety-checkpoint.log`. Changedbot target-write failure failsclosed withoutgrants, needsreset.
- Stalled HTTP body red `/tmp/telegram-deadlines.log`; explicit bounded consumption+destroy fixes6clienttests `/tmp/telegram-body-green.log`. /reply4000payload excludingcommand red/green `/tmp/telegram-length-*.log`.
- Council /root/council decided bot/min/reason rejected summaries no false attribution;450individual+50summary quotas, protectedclaimed, limiterbeforefreshness. Recorded spec; shared auditbase schema with actor refinement, durableaggregation and duplicateguard; UI botwidecount. Added test flood/duplicates/retention and UIcount.95targetedgreen `/tmp/telegram-safety-final.log` before finalsummarytype factoring.
- Added droppedReplies health diagnostic via runtime/UI from existing dispatcher counter.
- Stage1 implementation scope complete; validation round1 started with fulltypecheck+targeted allserver/webhooks/telegram/settings. Firsttypecheck found safeExtend widening stateenum; factored shared identitybase schema then both HTTP and journaladd ownstateenum. Fulltypecheck PASS `/tmp/telegram-stage1-round1-types.log`.
- Round1 tests:3572pass/8fail `/tmp/telegram-stage1-round1-tests.log`:6establishedbaseline +hosttopic newunusedtopic registration +newtasklistred test that landed while run executing. Fix hosttopic onlyregister whenwebhooks exists, existingtestunchanged; /tasks budgetswholeescapedlines.17/17focusedregressions PASS `/tmp/telegram-round1-fixes.log`. Tasklist red `/tmp/telegram-tasklist-red.log`. ROUND1 COMPLETE with no unresolved new failures.
- ROUND2 NOW RUNNING full npmtest `/tmp/telegram-stage1-round2-tests.log`. After result fix anynew issues and recordround2. Then round3 build+unit(+types afterfinalchanges), round4 browser+docs, round5 finaltargeted andsafetyreview. Only afterround5 begin stage2 groups/cancelcontinue and its5rounds. No commit/push/livebot.

## Stage 1 validation round 2

Full `timeout 600 npm test`:12933 passed,6previouslyverifiedbaselinefailures(create-project4/provider-action-gating2),4skipped,815files,226.81s. Log `/tmp/telegram-stage1-round2-tests.log`. No new failures. ROUND2 COMPLETE. Round3 running types+test:unit+build logs `/tmp/telegram-stage1-round3-{types,unit,build}.log`, exec15071.

Stage1 acceptance evidence map (simulation only):
- 1–4/E: roundtrip.test structured/prose real lifecycle+receipt+poller+sharedmessagehelper; authorization stalecontinuation/episode; protocol unique prefixes; connect-arbiter/cache and browser pairing flow.
- 5–6/16a: protocol boundary, authorization, conversation postrecovery/finalgateguard, runtime wrongchat/one-notice.
- 7–9/C/D: state claim/write/result/recover/epoch/capacity; poller offset/backoff/bodycap; client DNS/stalledbody/timeouts; ownership loss.
- 10–13/A/B/F/H: service pairing/enable/replacewritefailure/flagoff/recovery; binding/project scope tests; connect owner arbitration; vault webhook tests; foreign identity/noimplicitcontext.
- 14–15: unchanged message/queued/continue and webhook tests, contract-parity.telegram and telegram-scope; fullsuite rounds1/2.
- 16/G: state aggregation noactor/dedupe/retention andfilebytecap, dispatcher bounds/retryTTL/limiter, UI cursor/subscription/summary.
- Browser1 stage1 concrete UI: consent, privatepair, approval,disable,revoke,diagnostics. No production impersonationroute or realtoken.

## Stage 1 validation rounds 3–4

ROUND3 COMPLETE: fulltypecheck pass, test:unit48/48, build pass inclcheck:pack1160files/167webassets. Logs `/tmp/telegram-stage1-round3-{types,unit,build}.log`. No corrections needed.
ROUND4 COMPLETE: realbrowser1/1 in6.09s freshlybuiltUI (fixtureonly,fakenetwork), docscheck204pages+Nextbuildpass. Logs `/tmp/telegram-stage1-round4-{browser,docs}.log`. No corrections needed.
ROUND5 RUNNING: final Telegram/webhooks/sharedmessages/queued/receipts/routeparity/hosttopic/UI regressions anddiffcheck. `/tmp/telegram-stage1-round5-tests.log`. Stage2still notstarted; waitround5result.

## Stage 1 completed; stage 2 underway

ROUND5 COMPLETE:760/760tests79files,15.59s `/tmp/telegram-stage1-round5-tests.log`; gitdiffcheckclean. All five stage1rounds completed sequentially before stage2code.
Stage2 shared control extraction: `server/run-controls.ts` continueUserRun/cancelUserRun; HTTP receipt/fallback/response rules kept in server. Existing57continue/messages/queued tests unchanged pass `/tmp/telegram-stage2-extraction.log`; servertypecheckpass.
Council savedaccount/model decision recorded spec: current run.agentProfile priority, then saved matchingproviderprofile; ifunknown denyTelegram(notHTTP), explicitdefaultallowed; Auto model allowed, neveroverride opts.model; fingerprintmustincludeaccountmapping/modelpolicy/session/status/continuation. Actions NOT IMPLEMENTED YET.
Groupfoundation: Pairings supportsprivatecandidatefornegativegroupID andsixdigitstablecomparison; firstcandidatefixed. Runtime sendscomparisonprivately, throttled, validatesstillcurrent; groupgetChatcheck beforepair/enable requiresvisibilityconsent, group/supergroup/nonforum. Confirmrequirescomparison; addingsecondpersonkeepsfirstenablegeneration; permissions PATCH/API/UI perpersondefaultrespond. Revoke preservesotherperson. Newtestgroupcontroller passes.
Groupadministrativeevents module: migration/removal handledbeforetextfilter, atomicoffset+disabled+generation+correlationclear onlyaffectedchat, durable suspendedReason optional. Runtimeallowed_updates message/callback_query/my_chat_member (callback handlerstillpending). Conversation allowsgroups onlysuffixedcommands ornativeReply, ignoresambient/otherbot; groupgrantdoesnotauthorizeprivatechat. Connectcacheusesgroupchat.title.
UI groupvisibilityconsent andcomparisoncheckbox, Pairperson availablewithothergroupgrants, cancel/continuepermissioncheckboxes. Typedclient params, PATCHroute, paritynewroute, BCentry. Existingprivatee2enotyet rerun afterstage2.
Checks:93backendtests `/tmp/telegram-stage2-groups.log`,105backend+routes+UI `/tmp/telegram-stage2-group-checkpoint.log`, fulltypecheckPASS `/tmp/telegram-stage2-group-types.log` beforefinalsuspendedReason/parity/groupconversation edits. NOW finalgroupscheckpointtests+fulltypecheck pending `/tmp/telegram-stage2-group-final{,-types}.log`.
Next: TelegramActions previews/random24bytecallback/100bot5user/TTL120s, sameactor/chat/message verification, one-timeclaim beforeawait, durableclaimed/outcome, strictsavedconfig providercontrol bridge, fastbounded answerCallbackQuery andbest-effortremovebuttons, recheck/revoke/receiptguards; sharedcontinue/cancel deps thread service/coordinator/server. Addactionsunit/integration/browser group+control flows, docs; then stage2FIVErounds all still0. No livebot/commit/push.

## Stage 2 controls implementation

- Added TelegramActions: random24byte capabilities, 120sTTL/100bot/5user caps, send receipt binding, sameactor/chat/message enforcement, synchronous consume before await, durable claimed/outcome, rejected callback summaries, bounded callback ack/edit, no retry of task effects.
- Added prepareTelegramControl: current recordedaccount beforehistorical, no default fallback, no runnerguess, modelAuto/locked handling, run/session/accountmapping fingerprints, sharedcontinue/cancel with finalgrantguard. Threaded optional callback through coordinator/service/runtime. Conversation previews only; dispatcher attaches inline button, runtime routes callbacks.
- Tests actions15 + controls12 + conversation roundtrip + existing telegram tests; checkpoint131pass. New rejection audit sortedjournal test corrected to find actionId, not assumearrayorder. Groupdisable UI bug provenred /tmp/telegram-group-disable-red.log thenfixed.
- Browser2/2 /tmp/telegram-stage2-browser-pre2.log: private flow + groupvisibility/comparison/perpermission/disable/revoke. Uses injected fakeTelegram; no livebot. Firstbrowserrun surfaced bootstraprevision UX, now descriptiveerror+refreshedretry. Docs updated.
- STARTING stage2 acceptance ROUND1: fulltypes and broadtargeted. Five rounds still outstanding.

## Stage 2 acceptance round 1

ROUND1 COMPLETE: full npm run typecheck passed; broad Telegram/webhooks/server/settings 3611passed/6knownbaseline failures in283files, /tmp/telegram-stage2-round1-{types,tests}.log. Extra safety30pass (crashresultwrite→recoveryuncertain, boundedack, queuedcancel), finalfocused43pass /tmp/telegram-stage2-round1-final.log. Hardened preview error handling/stalecommand check. ROUND2 fullsuite now running /tmp/telegram-stage2-round2-tests.log.

## Stage 2 acceptance round 2

ROUND2 fullsuite:12972passed/6knownbaseline failures(create-project4/provider-action-gating2),4skipped,818files,226.19s. `/tmp/telegram-stage2-round2-tests.log`. No new failures. Review found missing-account audit should be exact account_unknown per council; added closed refusal class and test. Added real-grant revocation and unrelatedconfiguration preview isolation + no-permission control regressions. Focused fixes logs round2-fixes andround2-final. Starting ROUND3 fulltypes→unit→build→package.

## Stage 2 acceptance round 3

ROUND3 COMPLETE: fulltypecheck, unit48/48, build/checkpack1172files167assets pass. Package32/33 first failed from personal ~/.npmrc allow-scripts incompatible with child npm --ignore-scripts. Re-run with npm_config_userconfig=/dev/null retains --ignore-scripts:33/33pass, installedtarballCLI exercised. No configfile edits. Logs /tmp/telegram-stage2-round3-*.log. Browser test combined bothreceiver flows into one self-contained scenario to avoid inter-test state dependency. ROUND4 browser+docs running.

## Stage 2 acceptance round 4

ROUND4 COMPLETE: realbrowser composite private+group flow1/1 in4.23s, /tmp/telegram-stage2-round4-browser.log; docscheck204pages andNextbuild pass /tmp/telegram-stage2-round4-docs-{check,build}.log. No corrections required. ROUND5 finaltargeted Telegram/webhooks/sharedHTTP/routeparity/UI +diffcheck running.

## Stage 2 acceptance round 5 and completion

ROUND5 COMPLETE:832/832tests84files,16.54s; /tmp/telegram-stage2-round5-tests.log; diffcheck clean. All five stage2rounds completed after stage1's five rounds. No remaining implementation work in this spec. Spec rev8 records final evidence and limitations. No liveTelegram test, commit, push or external messages.

Stage2 evidence map:17/J groupservice+pairing+protocol+conversation+browser;18/19 actions/controls/conversation realgrantrevoke+permissiontests;20 controls savedaccount/modelpolicy/session/mapping/authguard;21 group-events migration/removal unrelatedchat;22 fullsuite+unchangedHTTP tests round5;I actions failedresultwrite recoveryuncertain+restartoldbutton+duplicateIDs;K dispatcher revokedreply/actionsprune +conversation unrelatedconfig isolation +group-events unaffectedreceiver.
