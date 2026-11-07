import { runBundledWorker } from '../../src/extensions/bundled-worker.ts'
import { slackWorkerTransport } from '../../src/chat/providers/slack/bundled-adapter.ts'

runBundledWorker('slack', (config, host) => slackWorkerTransport(config, host))
