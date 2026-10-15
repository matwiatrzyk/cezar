# Outbound task webhooks

Webhooks send signed task notifications from a running cezar server to a receiver you control.
They can notify a chat or phone through a relay. They do not start tasks or accept answers.
The receiver must accept **cezar JSON**, not Slack or Discord's message format directly.

## Supported server platforms

Delivery currently requires **Linux with /proc available** for verified process ownership.
macOS and Windows are unsupported; setting the enable flag does not add platform support.
Health reports `capabilities.webhooks: false` and
`capabilities.webhooksUnavailableReason: "unsupported_platform"` on these servers,
regardless of the flag. Webhook API routes return 409 with the platform explanation before
opening storage. Settings shows this explanation instead of instructions to enable delivery.
This refers to the server OS, not the browser's OS.

On Linux, the reason field is absent and delivery remains off unless explicitly enabled.
A Linux ownership or storage failure still reports the existing storage/coordinator error.

## Enable and connect

1. Start cezar with `CEZ_WEBHOOKS=1` in its server environment. Restart after changing the flag.
   Without the flag, the Webhooks settings page explains how to enable delivery; it creates no
   webhook storage, capture observers, timers or requests.
2. Open your project's **Settings → Webhooks**, then **Add receiver**. Use an HTTPS receiver URL.
   Paths and query strings may contain credentials: cezar masks them in lists and delivery history.
3. Keep **Minimal** initially. Save and copy the signing key into your receiver's secret storage.
   The cockpit shows that key once. If you lose it, rotate it.
4. Send a test. It contains only a synthetic connection event, never a project name, task or question.
   A passing test means the receiver accepted it; it does not prove a chat or phone displayed it.
5. Activate after reviewing the destination and data profile. Only events captured **after** activation
   are eligible. Existing tasks are not backfilled. Pause and Resume also establish a new capture fence.

A local server can send to a private receiver after explicit local-network consent, including for
Test. Hosted mode requires public HTTPS. Local HTTP is unencrypted even with a signed body.
Loopback cezar ports, metadata services and unsafe DNS/address forms are always denied. Redirects
and corporate environment proxies are unsupported; use a directly reachable receiver with a valid
TLS certificate. DNS is revalidated and pinned for every attempt.

## What is sent

| Event | Meaning |
| --- | --- |
| `task.attention_required` | Task entered waiting, or an explicit question was replaced. |
| `task.review_ready` | Task entered the review gate. |
| `task.finished` | Task finished; `resolution` explains PR opened, accepted, no changes, completed or unknown. |
| `task.failed` | Task is still failed after at least 30 seconds and is no longer active or continuing. |
| `task.cancelled` | Task was cancelled. |
| `webhook.test` | Synthetic receiver setup check. |

The default preset selects attention, review, finished and **manual** failure. **All results** adds
cancelled and scheduled failures. **Custom** lets you select types and scheduled failure delivery.
The default scope covers main tasks and explicit questions from children; **Every task** includes
children's other selected events. The default waiting/review grace is three minutes, with 0, 1, 3
and 10 minute choices. An answered question, continued task or archived task can make a queued
attention/review/failure notification obsolete before it is sent.

Minimal sends IDs, states, timestamps and structural fields. It includes a title only when the
user authored it. Standard can additionally send generated titles, questions and bounded error
text. Neither profile includes prompts, transcripts, credentials, file contents or local paths
by design. Outbound secret redaction always runs, even when transcript redaction is disabled,
but cannot recognize every possible secret embedded in free text. Choose Standard deliberately.
Recognizable filesystem paths in free text are redacted before capture and rendering. A path
without quotes may contain spaces, so redaction conservatively omits the rest of that text line;
quoted paths and HTTP(S) links preserve surrounding context. This is a syntax-based safeguard,
not general data-loss prevention: encoded or otherwise disguised sensitive text can escape it.
Already frozen delivery bodies are not rewritten, preserving retry and Replay byte identity.
Known secrets are redacted before title/error length limits. When an oversized title or error
contains an HTTP(S) URL, its retained excerpt ends before the first such URL. This can omit
additional context, but avoids retaining a partial destination that later secret redaction
cannot recognize. Short text retains complete links. Delayed failure rendering also checks
the current set of receiver URLs and signing keys.

Bodies are capped at 64 KiB and may include `truncated: true`.

Completion events include measured token counts and cost when available. Their usage coverage
is marked partial because some steps or providers may not report every measurement; absent
measurements are omitted. GitHub links are rebuilt for the configured project repository only.
For a PR, the created-PR reference takes precedence over the task's referenced PR and then the
GitHub automation source. For an issue, a tracker automation reference matching the current Jira/Linear connection and
association takes precedence, followed by the task's GitHub reference and GitHub automation
source. Each candidate must validate before it can win; invalid candidates do not mask a valid
fallback. Query strings and fragments are discarded. Tracker title slugs are discarded too.
Hosted events may include `links.cockpit` only when one installed local server record matches
both the running service identity and actual port and supplies a public HTTPS origin. Local
mode, missing identity and ambiguous records omit it; request headers never supply that URL.

See [JSON Schema](webhooks.schema.json), generated from the shared Zod contract. Unknown optional
fields should be tolerated by consumers; handle unknown event types without side effects. The
transport headers below are separate from the JSON envelope.

## Verify before processing

Read the exact raw request body before JSON parsing. Verify:

- `webhook-id`: stable event ID; it must equal JSON `id`.
- `webhook-timestamp`: integer Unix seconds for **this attempt**; reject more than five minutes of skew.
- `webhook-signature`: space-separated `v1,<base64 HMAC-SHA256>` signatures.

Decode the Base64 part of the signing key after its `whsec_` prefix. Sign the exact bytes
`webhook-id + "." + webhook-timestamp + "." + raw-body`. Compare signatures in constant time.
Do not reserialize JSON, verify only the JSON timestamp, or use the textual Base64 key as HMAC key.
During graceful rotation accept either configured key. Remove the old key after its 24-hour overlap.
A second graceful rotation is refused during an active overlap. **Revoke now** invalidates both
previous keys immediately; update the receiver promptly. A request already in flight cannot be recalled.

Signatures authenticate possession of the shared key. Processes running as the same OS user can
read keys or configure receivers through the local API. They can forge a valid event. The change
banner is best-effort detection, not proof of human approval or a boundary against such processes.
Do not use these notifications alone to approve payments, deployments or privileged actions.

## Delivery and acknowledgement

Return 2xx only after the desired work is completed durably, or after it is in your own durable queue.
The total request budget is ten seconds. cezar retries connection errors, 408, 429 and 5xx, using
backoff and Retry-After, within a 72-hour delivery lifetime. Other 4xx stop that delivery; 410 disables
the receiver. No redirect is followed. Ordering across events is not guaranteed.

History keeps HTTP status and safe failure reasons. Response bodies are omitted for private
destinations and URLs containing a path or query: a receiver or proxy can echo destination
credentials in forms that cannot be reliably redacted. For public origin-only URLs, response
diagnostics are retained only when the complete response is smaller than 4 KiB. Incomplete
responses and responses reaching that limit are omitted, without waiting for more bytes;
HTTP status and safe headers remain available. Optional diagnostics are also omitted if their
JSON representation exceeds the space reserved for a delivery result. If receiver configuration
changes during a request, response and header text are omitted because secret coverage may
have changed; HTTP status and valid Retry-After timing remain available.
A Retry-After beyond the delivery lifetime
expires the delivery rather than causing an earlier retry.

Deduplicate using the event ID, scoped to a trusted receiver/installation. Serialize concurrent
requests for the same ID. Under that serialization: look up completed IDs without mutating them;
post the notification; durably record completion; then acknowledge. Keep completed IDs at least
72 hours. Recording the ID before the post can permanently lose a message after a downstream failure.
A crash after a successful post but before completion is saved can duplicate its effect. Delivery is
not exactly once, and storage failure, expiry, policy blocks or capacity can prevent delivery altogether.

Retry now keeps the same event and delivery. Replay creates another delivery cycle with the same
event ID and immutable body, so your receiver may deliberately deduplicate it. Replay is available
only for retained eligible deliveries and the current receiver configuration; it never recreates a
payload that has expired. Scheduled failure bytes are never rewritten as manual failure on retry.

## Receiver states and history

- **Inactive:** saved but not activated. Test does not activate it.
- **Active:** accepts new selected events.
- **Paused:** stops admission and cancels unsent work. Resume starts with future events.
- **Suspended:** ten consecutive transient failures caused automatic backoff. Eligible work is probed
  after fifteen minutes. A successful Test also recovers the receiver and can release queued work;
  the cockpit discloses that before sending the test.
- **Disabled:** a 410 response disabled delivery. Repair the destination and pass a test before activation.

A permanent Test failure blocks activation of that configuration until a successful test or a
relevant configuration edit. Changing delivery settings returns the receiver to Inactive and
cancels pending work; renaming preserves activation. Confirmations show pending/in-flight counts.
Pause, Edit and Delete cannot undo a request already received by the destination.

Delivery payloads and Replay eligibility are retained for seven days after terminal completion.
Masked delivery/activity history is retained up to thirty days within finite storage limits.
Delivery pages show the latest 100 entries and offer older retained pages; status filtering applies
to loaded entries, while the task-ID filter is applied on the server. Deleted receivers remain as
read-only historical identities while retained history exists, without keys or usable destinations.
Removing a project pauses receivers when this server owns them; heed any warning if that write fails
or another server owns the project.

## Node relay to Slack or Discord

[webhook-relay.mjs](webhook-relay.mjs) is a dependency-free Node 20+ recipe. Run it separately from
cezar. cezar does not install, host or monitor it. Set these in the **relay** environment using your
usual secret-management mechanism; do not paste keys or chat URLs into task prompts or commit them:

| Variable | Value |
| --- | --- |
| `WEBHOOK_SECRET` | Receiver signing key. |
| `WEBHOOK_PREVIOUS_SECRET` | Optional old key during the overlap only. |
| `CHAT_TARGET` | `slack` or `discord`. |
| `CHAT_WEBHOOK_URL` | Private HTTPS incoming-webhook URL for the chat destination. |
| `COMPLETED_STORE` | Persistent local path; default `./relay-state/completed.json`. |
| `RELAY_PORT` | Local listen port; default `8788`. |

Run `node webhook-relay.mjs`. It listens on `127.0.0.1:8788/webhook`; configure a trusted TLS reverse
proxy if it must be reached remotely. For a local cezar using this loopback URL, enable local-network
consent. Slack escaping disables special mention/link syntax; Discord sends `allowed_mentions: {parse: []}`.
The target's own channel permissions and notification settings decide who sees the message.

Use exactly **one relay process and one signing-key trust domain per completion store**. The CLI
creates an exclusive `.lock` beside it and fails closed if that lock already exists. After an abrupt
crash, stop and verify the previous process is gone before removing its stale lock and restarting.
Do not share the store across hosts, containers or workers. Completed IDs survive restart; abandoned
in-flight work is retried by cezar. Different IDs' atomic store updates are serialized too.

The store holds up to 50,000 unexpired IDs / 8 MiB and refuses new completion writes when full;
provision a separate durable queue/store for higher throughput. A failed completion write returns
503 even after chat succeeded, so a retry can duplicate that message. No valid retained ID is evicted
early to make room. Keep the state directory outside git and private to the relay user.

## n8n workflow

Import [webhook-n8n.json](webhook-n8n.json) into **n8n 2.43.4**. It is saved inactive. Configure the
supplied Node relay first, then set the HTTP node's URL to that relay. The default loopback URL
works only when n8n and the relay share a network namespace; across hosts use authenticated HTTPS
routing and a directly reachable relay. Run a setup test before publishing the workflow.

The workflow is an adapter to the same durable receiver: **raw Webhook → verify/serialize/post/commit
relay → Respond to Webhook**. Its HTTP node deliberately delegates all four steps to one shared
relay process instead of spreading a lock across n8n executions. All concurrent n8n workers must
use that same relay and signing-key trust domain. The relay, not n8n static workflow data, owns the
completed-ID store. n8n Cloud and any topology without access to that receiver are not validated.

Keep Raw Body enabled, binary request-body forwarding and the three signature headers unchanged.
Do not add JSON reserialization, immediate response, HTTP node retries, or a Remove Duplicates node.
The response node forwards the relay's status, including retryable 503 failures, only after the
relay answers. Execution payload storage is disabled in this template; n8n/proxy administrators
must separately review their logging, persistence and access policies. n8n sees the raw event.
The receiver key and chat URL live only in the relay environment, never in the exported workflow.

The version-pinned acceptance check runs the actual imported/published n8n workflow inside a Docker
container with networking disabled, plus a loopback relay and an injected fake chat sink. It checks
raw-byte signature rejection, duplicate success ACK, failed chat followed by retry, concurrent same-ID
requests and completed-store restart. Run from the repository with
`node packages/cezar/scripts/check-webhook-n8n.mjs`. The pinned image digest is recorded in that
script. The container is removed afterwards. Relay unit tests separately exercise completion-write
failure and cross-ID store races. No real Slack, Discord or other receiver is contacted.

See n8n's [Raw Body and response modes](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)
and [Respond to Webhook](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.respondtowebhook/).

## Operation and boundaries

Private state lives below each project's `.ai/cezar/webhooks/`, with restrictive permissions and
verified git exclusion. One verified owner process sends for each project; another instance reports
unavailability instead of competing. Unsupported owner-identity platforms fail this optional service
closed. The current owner implementation verifies Linux process start and boot identity.

Capture is synchronous and non-throwing so webhook persistence cannot fail a task. It is not an
fsync transaction with the task index: a crash or disk error can lose capture. Standard source text
is a second redacted plaintext copy on disk. Copying state to another root resets receivers, keys,
identity and queue instead of sending another installation's notifications. Dry-run uses separate
state and does not send receiver traffic.

If an established project's failure identity index is missing or corrupt, retained sources and
attempts can restore only the episodes they prove. Health remains **degraded** across restarts
when completeness cannot be established; some later failure alerts may be unavailable. The
service does not invent historical alerts from current task metadata. New captures continue.

Only a server observing its project sees live transitions. A separate headless `cezar run` or
non-owner process can change a task without producing a lifecycle webhook. Lightweight discovery
of enrolled projects does not start task managers. A server that never opened a task context treats
persisted resume metadata as manual; a live scheduled notification requires a real manager timer.

`CEZ_WORKFLOW_WEBHOOKS` is independent: it enables an HTTP node **inside a workflow graph**, whose
result can affect graph execution. `CEZ_WEBHOOKS` observes task lifecycle outside the workflow.
They do not share receivers, signing keys, delivery IDs, retries or rate budgets. Pausing lifecycle
receivers does not stop workflow-node HTTP, and a lifecycle delivery failure cannot fail the task.

Use the guide and script from the same cezar release/tag you run. These documentation recipes are
repository assets, not runtime imports or components of the npm service.
