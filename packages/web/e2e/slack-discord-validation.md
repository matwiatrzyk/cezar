# Slack and Discord simulated browser validation

These suites drive the built cockpit through a real Chromium browser with deterministic
e2e screen actions. No agent steps, platform credentials, API calls or downloads.
The simulator supplies native Slack Socket Mode envelopes / Discord Gateway frames and
REST results to the real adapters through coordinator slackWire / discordOptions.
It never substitutes a shared fake ChatProvider.

Prerequisites: existing local node_modules, e2e + @e2e-dev/web, cached Chromium,
Undici **6** (validated by fixture startup), and a C compiler on Linux.
Do not install or download dependencies to run this offline validation.

From the repository root, build the cockpit and compile the loopback guard:

    timeout 30 cc -shared -fPIC packages/web/e2e/slack-discord-netguard.c -o /tmp/chat-netguard.so -ldl
    LD_PRELOAD=/tmp/chat-netguard.so timeout 120 node node_modules/vite/bin/vite.js build --config packages/web/vite.config.ts

Run each configuration under the guard, replacing PROVIDER with slack or discord:

    LD_PRELOAD=/tmp/chat-netguard.so E2E_TELEMETRY=0 timeout 120 npx --no-install e2e run --config packages/web/e2e/PROVIDER-inbound.config.ts

Also run PROVIDER-group, PROVIDER-test-gate, PROVIDER-retry and
PROVIDER-group-approval configurations. Each starts its own disposable project/home,
cockpit server, simulator and fixture-control listener on the adjacent loopback port.
The command explicitly forwards LD_PRELOAD to the app subprocess (e2e filters
inherited app environment). The guard was verified in app and Chromium process maps.
The e2e runner owns process teardown; the fixture closes its listeners and removes its
disposable root. Reports and failure traces live in packages/web/e2e/.e2e/PROVIDER-*.
Synthetic diagnostic snapshots go to the OS temporary directory as
PROVIDER-browser-PORT.json.

Coverage:

- inbound: existing webhook receiver upgraded in the browser without changing ID;
  no credential effects before dedicated-bot consent; copyable manual discovery;
  private approval and Start permission; bot test delivery; recreate server,
  coordinator, store and manager from persisted state; native task request, explicit
  Confirm, exactly one ordinary dry-run task, final bot reply, public source redaction.
- group: manual mentioned discovery, visibility consent, notification-only activation,
  same receiver, recreate server stack, then browser Send test reaches the same group.
- test-gate: bot delivery failure leaves notifications inactive and no access grants.
- retry: same failed-test scenario followed by successful retry, preserving receiver ID.
- group-approval: group notifications followed by a second private discovery, comparison
  consent and task-control approval; persisted group access after restart; group task
  creation rejected; ordinary task notification without private answer prose; native
  unmentioned thread/reference reply delivered to the exact task, with group-only
  correlations and the expected provider attribution.

The simulated runner emits synthetic token/cost counters; it makes no model calls.
The fixture completes the task only after the mock runner parks, to avoid racing its
first turn. Restart recreates the server stack in the same process, using saved state;
it does not simulate a machine crash.

Expected result: all ten configurations pass (one test per configuration, report status
passed, exit code 0). Reports live under packages/web/e2e/.e2e/NAME/report.json.

Limits: simulated platform wire, not live Slack/Discord accounts. Restart recreates
the server stack in-process, not an OS crash. Credential rotation, consent revocation
and crash recovery are not claimed by these browser suites. This is integration
completion evidence, not an independent product security review.
