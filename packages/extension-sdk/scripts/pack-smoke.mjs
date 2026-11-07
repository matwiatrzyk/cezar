import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const example = resolve(sdk, '../../examples/extensions/project-summary')
// The host smoke below packs the service with --ignore-scripts, so it must already be built.
if (!existsSync(resolve(sdk, '../cezar/dist/extensions/manager.js'))) {
  console.error('pack-smoke: packages/cezar/dist is missing — run `npm run build` at the repository root first.')
  process.exit(1)
}
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
  run(process.execPath, [join(project, 'node_modules/typescript/bin/tsc')], project)
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
  const chatProject = join(temp, 'mattermost')
  cpSync(resolve(sdk, '../../examples/extensions/mattermost'), chatProject, { recursive: true, filter: source => !source.includes('/node_modules') && !source.includes('/dist') })
  const chatPkg = JSON.parse(readFileSync(join(chatProject, 'package.json'), 'utf8'))
  chatPkg.dependencies['@open-mercato/cezar-extension-sdk'] = tarball
  writeFileSync(join(chatProject, 'package.json'), JSON.stringify(chatPkg))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], chatProject)
  run(process.execPath, [join(chatProject, 'node_modules/typescript/bin/tsc')], chatProject)
  writeFileSync(join(chatProject, 'smoke.mjs'), `
import assert from 'node:assert/strict'
import extension from './dist/index.js'
let factory
await extension.activate({ chat: { register(id, value) { assert.equal(id, 'chat'); factory = value; return { dispose() {} } } } })
const bot = 'b'.repeat(26), channel = 'c'.repeat(26), person = 'p'.repeat(26), post = 'x'.repeat(26)
const calls = []
globalThis.fetch = async (url, init) => {
 assert.equal(init.headers.Authorization, 'Bearer fixture-token')
 calls.push({url, init})
 if(url.endsWith('/users/me'))return Response.json({id:bot,username:'cezar-bot'})
 if(url.includes('/members/'))return Response.json({user_id:person})
 if(url.endsWith('/channels'))return Response.json([{id:channel,type:'D',delete_at:0}])
 if(url.includes('/posts?'))return Response.json({posts:{[post]:{id:post,user_id:person,channel_id:channel,message:'cezar start fixture-code',create_at:Date.now(),delete_at:0,root_id:'',type:''}}})
 if(url.endsWith('/posts'))return Response.json({id:post})
 return Response.json({id:channel,type:'D',delete_at:0})
}
const adapter = await factory({server:'https://mattermost.example',token:'fixture-token'})
assert.equal((await adapter.identify()).id, bot)
assert.equal((await adapter.inspect('private:'+channel)).kind, 'private')
assert.equal((await adapter.receive(Date.now()-1000))[0].event.text, '/start fixture-code')
assert.equal((await adapter.send('private:'+channel,{text:'Hello'})).messageId,post)
assert.equal(await adapter.isMember('private:'+channel,person),true)
await adapter.dispose()
assert(calls.length >= 5)
`)
  run(process.execPath, ['smoke.mjs'], chatProject)
  // Install the published-shape service too: private workspace packages must not
  // accidentally satisfy runtime imports in this external consumer.
  const service = resolve(sdk, '../cezar')
  const servicePack = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp], service))
  const cockpit = join(temp, 'cockpit'); mkdirSync(cockpit)
  writeFileSync(join(cockpit, 'package.json'), JSON.stringify({ name: 'extension-pack-host', private: true, type: 'module' }))
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=optional', join(temp, servicePack[0].filename)], cockpit)
  writeFileSync(join(cockpit, 'host-smoke.mjs'), `
import assert from 'node:assert/strict'
import { ExtensionManager } from './node_modules/@open-mercato/cezar/dist/extensions/manager.js'
const manager = new ExtensionManager(${JSON.stringify(join(temp, 'data'))}, 'external', ${JSON.stringify(temp)}, {
 home: ${JSON.stringify(join(temp, 'home'))}, listTasks: async () => [{ id: 'pack-task', title: 'Packed host', status: 'done' }],
})
try {
 const record = await manager.install(${JSON.stringify(project)})
 await manager.setEnabled(record.manifest.id, true, record.integrity)
 const panel = await manager.panel(record.manifest.id, 'summary')
 assert.equal(panel.blocks[0].rows[0][0], 'Packed host')
 await manager.setEnabled(record.manifest.id, false)
 await assert.rejects(manager.panel(record.manifest.id, 'summary'), /enabled/)
} finally { await manager.close() }
`)
  run(process.execPath, ['host-smoke.mjs'], cockpit)
  console.log('PASS: installed Cezar tarball activates the external SDK-built extension in a real worker without workspace dependencies')
  console.log('PASS: Mattermost example built outside workspace and exercised identity, discovery, receive, send and membership with the public SDK')
  console.log('PASS: packed SDK installed outside workspace; example typechecked, imported, activated, invoked and disposed')
} catch (error) {
  if (error.stdout) process.stderr.write(error.stdout)
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  rmSync(temp, { recursive: true, force: true })
}
