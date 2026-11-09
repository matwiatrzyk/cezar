import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sdk = resolve(plugin, '../../extension-sdk')
const temp = mkdtempSync(join(tmpdir(), 'cezar-telegram-pack-'))
const env = { ...process.env }
for (const key of Object.keys(env)) if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key]
const run = (args, cwd) => execFileSync('npm', args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
try {
  const sdkPack = JSON.parse(run(['pack', '--json', '--pack-destination', temp], sdk))[0]
  const pluginPack = JSON.parse(run(['pack', '--json', '--pack-destination', temp], plugin))[0]
  const consumer = join(temp, 'consumer')
  mkdirSync(consumer)
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'telegram-consumer', private: true, type: 'module', dependencies: {
    '@open-mercato/cezar-chat-telegram': join(temp, pluginPack.filename),
    '@open-mercato/cezar-extension-sdk': join(temp, sdkPack.filename),
  }}))
  run(['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer)
  const check = `import { telegramRequest } from '@open-mercato/cezar-chat-telegram';
const request = telegramRequest('123456:${'A'.repeat(24)}', { lookup: async () => [{ address: '8.8.8.8', family: 4 }], request: async () => ({ statusCode: 200, body: { async *[Symbol.asyncIterator]() { yield JSON.stringify({ ok: true, result: { id: 1 } }) }, destroy() {} }, }) });
const result = await request('getMe', {});
if (result.id !== 1) throw new Error('packed Telegram consumer failed');`
  execFileSync(process.execPath, ['--input-type=module', '-e', check], { cwd: consumer, timeout: 120_000, stdio: 'inherit' })
  console.log('PASS: packed Telegram plugin and packed public SDK install and run outside the workspace')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
