import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const example = resolve(sdk, '../../examples/extensions/project-summary')
const temp = mkdtempSync(join(tmpdir(), 'cezar-sdk-pack-'))
// npm forwards workspace configuration to lifecycle scripts; it is not valid
// for an unrelated consumer install. Install scripts remain explicitly disabled.
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key]
}
const run = (bin, args, cwd) => execFileSync(bin, args, { cwd, env, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] })
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], sdk))
  const tarball = join(temp, packed[0].filename)
  if (packed[0].files.some(file => file.path.startsWith('src/'))) throw Error('Tarball must ship built artifacts')
  const project = join(temp, 'consumer')
  cpSync(example, project, { recursive: true, filter: source => !source.includes('/node_modules') && !source.includes('/dist') })
  const pkg = JSON.parse(readFileSync(join(project, 'package.json'), 'utf8'))
  pkg.dependencies['@open-mercato/cezar-extension-sdk'] = tarball
  writeFileSync(join(project, 'package.json'), JSON.stringify(pkg))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], project)
  run('npm', ['run', 'build'], project)
  writeFileSync(join(project, 'smoke.mjs'), `
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { extensionManifestSchema } from '@open-mercato/cezar-extension-sdk/schemas'
import extension from './dist/index.js'
const manifest = extensionManifestSchema.parse(JSON.parse(readFileSync('./cezar-extension.json', 'utf8')))
assert.equal(manifest.entry, 'dist/index.js')
assert.deepEqual(manifest.permissions, ['project.read'])
const commands = new Map(), panels = new Map(), listeners = new Set()
const register = map => (id, handler) => { map.set(id, handler); return { async dispose() { map.delete(id) } } }
let tasks = [{ id: '1', title: 'First', status: 'running' }]
const context = {
 projectId: 'external', permissions: manifest.permissions,
 tasks: { list: async () => tasks },
 commands: { register: register(commands) }, panels: { register: register(panels) },
 taskEvents: { subscribe(handler) { listeners.add(handler); return { async dispose() { listeners.delete(handler) } } } },
}
const cleanup = await extension.activate(context)
assert.equal((await panels.get('summary')()).blocks[0].rows[0][0], 'First')
tasks = [{ id: '2', title: 'Second', status: 'done' }]
assert.deepEqual(await commands.get('refresh')(undefined, context), { message: 'Summary refreshed' })
assert.equal((await panels.get('summary')()).blocks[0].rows[0][0], 'Second')
await cleanup.dispose()
assert.equal(commands.size + panels.size + listeners.size, 0)
`)
  run(process.execPath, ['smoke.mjs'], project)
  console.log('PASS: packed SDK installed outside workspace; example typechecked, imported, activated, invoked and disposed')
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  rmSync(temp, { recursive: true, force: true })
}
