# Cross-PR automatic-review audit of agent fallback

2026-10-21. Scope: prevent analogous defects in this task's diff before submitting it.
This is local verification, not a GitHub review submission or a promise of future bot approval.

## Retrieved evidence

Using read-only GitHub API calls through gh:

- Repository inline review comments: 66 returned (all fit one page); 41 authored by Codex,
  Copilot or GitHub Advanced Security, across 13 PRs.
- Latest 100 issue/PR discussion comments (mostly conversations and preview-publication notices).
- 82 formal reviews across 36 PRs: latest 20 PRs plus PRs referenced by inline comments;
  46 have nonempty bodies. These include reports explicitly labelled om-auto-review-pr and
  other reviews published by human accounts. They are not all bot-authored.
- Local raw snapshots: /tmp/fallback-other-pr-{inline,discussion,reviews}.json.

No comments posted, no review submitted, no branch pushed. PR numbers below are sources,
not the subject PR of this task (this branch has not been submitted by this audit).

## Applicable lessons and disposition

| Source | Reported problem | Check/fix in this branch |
|---|---|---|
| [Codex, PR1479: stored unknown fields](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296009650), [request round trip](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296131158), [response round trip](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296471739) | Older versions erase newer metadata during unrelated saves or list replacement. | **Found and fixed.** Persisted project/candidate schemas retain unknown fields; writes retain project fields and candidate metadata by provider/account identity, including on reorder. Other projects retain their data. API responses still project exactly the documented closed shape. Explicit Auto still clears the previous model pin. Regression failed before fix. |
| [Codex, PR1479: path identity](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296587626), [alias identity](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296471723) | Shared state resolves differently across callers/processes. | Project keys already use realpath; added alias regression proving one policy for a directory and its symlink. **Also found and fixed:** pin CEZ_HOME policy path and project key before awaiting lock acquisition, and use that same path for read/write/release. Previously an environment change while awaiting could write into a different home from the lock. Regression failed before fix. |
| [Codex, PR1479: storage bounds](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296254931), [invalid defaults](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296471711) | Disk config bypasses API limits or raw key presence changes default semantics. | Candidate persistence enforces max10, provider enum, profile/model string bounds. Invalid policy fields degrade closed. Missing snapshot remains disabled. Projection preserves API bounds while opaque fields remain on disk. |
| [Codex, PR1479: GET skew](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296009654), [PUT skew](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296131172) | New UI crashes against an older server's response. | This is a new endpoint, so an older server returns404. Added UI guard test: show load error, omit editing switch, preserve Default models, perform no PUT. No fabricated enabled policy. Existing conflict/retry tests cover rejected mutations. |
| [Codex, PR1479: in-flight stale publication](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296009662), [shared cache](https://github.com/open-mercato/cezar/pull/1479#discussion_r4296254920) | Old promises undo revocation; second process keeps old state. | **Found and fixed.** Consent/disposal checks preceded further asynchronous launch preparation. Recheck live consent and state ownership after the last await, before consuming inbox messages and starting the provider. Two regression cases reproduce the unwanted session before the fix. Existing tests also cover admission, queued checks and restart. Policy reads use disk rather than an indefinitely cached promise. Durable holds reread shared entries. |
| [Copilot, PR1198](https://github.com/open-mercato/cezar/pull/1198#discussion_r4144503884), [counter reset](https://github.com/open-mercato/cezar/pull/1198#discussion_r4144503994) | Unbounded unattended loops and stale episode state. | Independent runtime audit verified the ten-candidate bound with a probe and found no additional loop/reset defect. Fallback has max10 distinct account candidates, a durable attempted set, terminal done flag and manual-Continue reset. Existing tests cover exhausted list, no return to starting account and unchanged default-off resume. |
| [Copilot, PR1051](https://github.com/open-mercato/cezar/pull/1051#discussion_r4148169181) | ARIA references absent DOM targets. | Added assertion that every fallback switch aria-describedby target exists. Scope disclosure uses native details/summary, not aria-controls pointing to an unmounted list. Error state has no switch. |
| [PR1283 review](https://github.com/open-mercato/cezar/pull/1283#pullrequestreview-5417230241) | Another window resurrects removed entries. | Policy updates use revision/incarnation CAS, not union merge. Stale revisions refuse with409, UI reloads, and another edit carries the new revision. Tests cover this and simultaneous writers. |
| [PR1407 review / CodeQL](https://github.com/open-mercato/cezar/pull/1407#pullrequestreview-5491810712), [PR1448](https://github.com/open-mercato/cezar/pull/1448#pullrequestreview-5534002448) | stat-then-read races, unvalidated stored payloads, leaked paths. | Durable hold entries are validated on read, filename/content identities checked, updates immutable and atomic. Policy transactions use serialized lock/reclaim; root stat is an availability check, not an authorization boundary for file content. API I/O failures use fixed messages; private paths/unknown fields do not leak through policy projection. Local CodeQL has not been run. |
| [om-auto-review-pr, PR1132](https://github.com/open-mercato/cezar/pull/1132#pullrequestreview-5337341092), [PR1460](https://github.com/open-mercato/cezar/pull/1460#pullrequestreview-5535783466) | Green checks omit platforms/components; runner launch paths disagree. | All production changes here are in existing npm-workspace validation. Fallback reuses normal runner launch, environment and tool paths. No desktop/native launch implementation is added. Real paid-provider exhaustion and Windows/macOS runtime behavior remain unverified locally; do not claim otherwise. |
| [PR1479 design review](https://github.com/open-mercato/cezar/pull/1479#pullrequestreview-5592396197), [PR925 gate](https://github.com/open-mercato/cezar/pull/925#pullrequestreview-5055457689) | Styling guard failures, wrong test environment, stale merge base. | Full standard validation includes design guardian; use TMPDIR=/tmp and isolate inherited cockpit env. Branch includes the previously fetched upstream08dc8428; no new merge was requested during this audit. No claim about future mergeability or CI result. |

## Local changes and evidence

Two regressions were confirmed red before fixing the policy store: unknown-field preservation
and transaction-home pinning. Symlink identity is a passing guard for existing behavior.
Additional UI guards cover older-server404 and valid accessibility relationships.
The API contract is intentionally not widened to expose private opaque metadata.


Independent runtime review (3baabe1e) reported one verified asynchronous-launch defect,
now fixed and covered by two repository tests (revoke/dispose during environment resolution).
Parent reproduced both tests red (sessionEverOpened=true); after fix no session is opened.
The child changed no tracked files. Its remaining loop/hold conclusions were checked against
source and the parent validation suite. No child merge was needed.

Final validation after all fixes:
- `npm run typecheck`: passed (contract/client/server/web).
- `env -u CEZ_API_URL -u CEZ_BIN -u CEZ_REMOTE TMPDIR=/tmp npm test`: 660 files passed, 1 skipped; 11122 tests passed, 4 skipped.
- `npm run test:unit`: 42 passed.
- `npm run build`: passed, including check:pack.
- `TMPDIR=/tmp NPM_CONFIG_USERCONFIG=/dev/null NPM_CONFIG_GLOBALCONFIG=/tmp/cezar-fallback-empty.npmrc npm run test:package`: 25 passed. Empty npm config avoids this machine's unrelated EALLOWSCRIPTS setting.
- `git diff --check`: passed.
- Targeted launch/continuation suites: 29 passed. Red evidence: two sessionEverOpened assertions returned true before the fix; final assertions treat absent sessionEverOpened as false, matching its optional production type.

Logs: /tmp/bot-lessons-final-{typecheck,full,unit,build,package}.log;
red proofs /tmp/bot-lessons-red.log and /tmp/bot-lessons-launch-red2.log.
These checks prevent the identified analogues; they do not predict every future bot finding.
