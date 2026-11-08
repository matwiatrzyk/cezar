import { runBundledWorker } from '../../src/extensions/bundled-worker.ts'
import { telegramWorkerTransport } from '../../src/chat/providers/telegram/bundled-adapter.ts'

runBundledWorker('telegram', (config, host) => telegramWorkerTransport(config, host))
