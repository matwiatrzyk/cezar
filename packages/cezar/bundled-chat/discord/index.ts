import { runBundledWorker } from '../../src/extensions/bundled-worker.ts'
import { discordWorkerTransport } from '../../src/chat/providers/discord/bundled-adapter.ts'

runBundledWorker('discord', config => discordWorkerTransport(config))
