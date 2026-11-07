#!/usr/bin/env node
// Build the bundled Slack/Discord workers into dist/bundled-chat/<id>/ and write catalog.json with
// each entry's sha512 (spec 2026-11-07-bundled-chat-workers). Workspace packages (the contract and
// the SDK) are bundled IN, so the artifact is self-contained and postbuild's inline-contract never
// rewrites it: the recorded digest is the digest of the file that ships. Only the published
// runtime dependencies (zod, ws, undici, …) stay external and resolve from the installed package.
//
// `--dist <dir>` writes to another dist (the spawned-worker integration test builds into a tmpdir).
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const flag = process.argv.indexOf('--dist')
const dist = flag === -1 ? path.join(packageRoot, 'dist') : path.resolve(process.argv[flag + 1])
const sourceRoot = path.join(packageRoot, 'bundled-chat')
const outputRoot = path.join(dist, 'bundled-chat')
const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]
const exists = file => stat(file).then(() => true, () => false)
const providers = []
for (const entry of await readdir(sourceRoot, { withFileTypes: true }).catch(() => [])) {
  if (entry.isDirectory() && await exists(path.join(sourceRoot, entry.name, 'manifest.json'))) providers.push(entry.name)
}
await rm(outputRoot, { recursive: true, force: true })
const manifests = []
for (const id of providers.sort()) {
  const source = path.join(sourceRoot, id)
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
  const output = path.join(outputRoot, id, 'index.js')
  await mkdir(path.dirname(output), { recursive: true })
  await build({ entryPoints: [path.join(source, 'index.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node20', external, sourcemap: false, logLevel: 'warning' })
  const bytes = await readFile(output), code = bytes.toString('utf8')
  // A workspace specifier would not resolve from the published tarball, and inline-contract would rewrite it.
  if (/(['"])@open-mercato\//.test(code)) throw new Error(`bundled-chat: ${id} worker still imports a workspace package`)
  await cp(path.join(source, 'manifest.json'), path.join(outputRoot, id, 'manifest.json'))
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  manifests.push({ ...manifest, id, entry: 'index.js', integrity })
}
if (manifests.length) {
  await writeFile(path.join(outputRoot, 'catalog.json'), `${JSON.stringify(manifests, null, 2)}\n`)
  console.log(`bundled-chat ok — ${manifests.map(m => m.id).join(', ')} built into ${outputRoot}`)
}
