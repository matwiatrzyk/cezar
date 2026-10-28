# Telegram stage 3 fair limiter implementation plan

Spec: 2026-10-27-telegram-bidirectional.md §18, council fair_limiter_council.
Work in existing isolated branch; no push/live bot. Ledger: ../telegram-inbound-progress.md.

1. Add telegram/send-budget.ts and tests: bounded ephemeral tickets, readiness, FIFO per chat,
   rotating ready chats, 1s/chat and100ms/bot, shared429 cooldown, cancellation/expiry, no timer ownership.
   Test fairness under delayed consumers and an old backlog, independentbots, saturation, sharedsource spacing.
2. Integrate controller-owned budget into service.ts/runtime.ts/dispatcher.ts. Replies advertise queued work,
   take slots only before calls, honor original TTL/retrycap and current valid(). Preserve cooldown across runtime.
   Add callback method cooldown in actions.ts; no polling through arbiter. Tests before implementation.
3. Integrate webhook service choose/claim/complete: advertise all eligible oldest-perchat heads, select ready
   tickets without waiting in scheduler/mutation queue, revalidate before claim, report429 to samebudget.
   Existing ProjectLimits remain. Verify mixedreply/webhook budget, unrelatedformats drain, noattempt onwait,
   outboundonly defaults and receiver mutation/expiry. No token-prefix identity inference.
4. Update docs and review full change independently. Fix findings with failing regression first.
5. Run five sequential acceptance rounds: (1)types+focused; (2)fullsuite andbaselinecomparison;
   (3)unit/build/pack/package; (4)browser+docs; (5)final regressions/diff and review findings.
   Document every result; do not claim stage3complete before all five.

Completed 2026-10-28: items1–5 implemented; independent review fixes verified; all five acceptance rounds recorded in ../telegram-inbound-progress.md and main spec §18.
