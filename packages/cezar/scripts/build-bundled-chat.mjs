#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = path.join(packageRoot, 'bundled-chat')
const outputRoot = path.join(packageRoot, 'dist', 'bundled-chat')
const providers = (await readdir(sourceRoot, { withFileTypes: true }).catch(() => []))
  .filter(entry => entry.isDirectory())
const manifests = []
for (const provider of providers) {
  const source = path.join(sourceRoot, provider.name)
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'))
  const entry = manifest.entry ?? 'index.js'
  const input = path.join(source, entry.endsWith('.ts') ? entry : 'index.ts')
  const output = path.join(outputRoot, provider.name, 'index.js')
  await mkdir(path.dirname(output), { recursive: true })
  await build({ entryPoints: [input], outfile: output, bundle: true, platform: 'node', format: 'esm', packages: 'external', sourcemap: false })
  await cp(path.join(source, 'manifest.json'), path.join(outputRoot, provider.name, 'manifest.json'))
  const integrity = `sha512-${createHash('sha512').update(await readFile(output)).digest('base64')}`
  manifests.push({ ...manifest, id: provider.name, entry: 'index.js', integrity })
}
if (manifests.length) {
  await mkdir(outputRoot, { recursive: true })
  await writeFile(path.join(outputRoot, 'catalog.json'), `${JSON.stringify(manifests, null, 2)}\n`)
} else {
  await rm(outputRoot, { recursive: true, force: true })
}
