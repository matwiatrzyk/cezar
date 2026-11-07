import { createHash } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const providerIds = ['slack', 'discord'] as const
const providerFormats = ['slack.v1', 'discord.v1'] as const

export const bundledProviderManifestSchema = z.object({
  id: z.enum(providerIds),
  version: z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
  entry: z.string().min(1),
  integrity: z.string().min('sha512-'.length).startsWith('sha512-'),
  format: z.enum(providerFormats),
}).superRefine((manifest, ctx) => {
  if (manifest.format !== `${manifest.id}.v1`) ctx.addIssue({ code: 'custom', path: ['format'], message: 'format must match provider id' })
})

export type BundledProviderManifest = z.infer<typeof bundledProviderManifestSchema>

export function reservedBundledProviderIds(): readonly ['slack', 'discord'] { return providerIds }

/** Validate both parts of an external provider key before it enters the project registry. */
export function validateBundledProviderCollision(id: string, format: string): void {
  if ((providerIds as readonly string[]).includes(id) || (providerFormats as readonly string[]).includes(format)) {
    throw new Error(`chat provider id or format is reserved by a bundled provider: ${id} (${format})`)
  }
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rel)
}

/** The catalog integrity is the sha512 digest of each immutable worker entry file. */
export async function bundledArtifactIntegrity(path: string): Promise<string> {
  return `sha512-${createHash('sha512').update(await readFile(path)).digest('base64')}`
}

/**
 * Read the generated package catalog without npm resolution. Every entry is constrained to
 * `dist/bundled-chat/<id>/` and checked before it is returned to a worker launcher.
 */
export async function loadBundledProviderCatalog(packageRoot: string): Promise<readonly BundledProviderManifest[]> {
  const root = resolve(packageRoot, 'dist', 'bundled-chat')
  const value: unknown = JSON.parse(await readFile(join(root, 'catalog.json'), 'utf8'))
  if (!Array.isArray(value)) throw new Error('bundled provider catalog must be an array')
  const manifests = value.map(item => bundledProviderManifestSchema.parse(item))
  const seen = new Set<string>()
  for (const manifest of manifests) {
    if (seen.has(manifest.id)) throw new Error(`duplicate bundled provider: ${manifest.id}`)
    seen.add(manifest.id)
    if (isAbsolute(manifest.entry)) throw new Error(`bundled provider entry must stay inside its provider directory: ${manifest.id}`)
    const providerRoot = resolve(root, manifest.id)
    const entry = resolve(providerRoot, manifest.entry)
    if (!contained(providerRoot, entry)) throw new Error(`bundled provider entry must stay inside its provider directory: ${manifest.id}`)
    const info = await lstat(entry).catch(() => undefined)
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error(`bundled provider entry artifact is missing: ${manifest.id}`)
    const actual = await bundledArtifactIntegrity(entry)
    if (actual !== manifest.integrity) throw new Error(`bundled provider integrity mismatch: ${manifest.id}`)
  }
  return manifests
}

/** The package that ships `dist/bundled-chat` (this file lives in `src/extensions` or `dist/extensions`). */
export function bundledPackageRoot(): string { return resolve(dirname(fileURLToPath(import.meta.url)), '../..') }

const catalogs = new Map<string, Promise<readonly BundledProviderManifest[]>>()
/**
 * The verified catalog, read and hashed once per process. Never throws: a source checkout (no
 * build), an old install or a tampered artifact keeps the in-process adapters, and says so ONCE.
 */
export function bundledProviderCatalog(packageRoot = bundledPackageRoot(), log: (level: 'info' | 'warn', line: string) => void = (level, line) => console[level](line)): Promise<readonly BundledProviderManifest[]> {
  let catalog = catalogs.get(packageRoot)
  if (!catalog) {
    catalog = loadBundledProviderCatalog(packageRoot).catch((error: unknown) => {
      const missing = (error as { code?: unknown })?.code === 'ENOENT'
      log(missing ? 'info' : 'warn', missing
        ? '[chat] bundled Slack/Discord workers are not built here; using the in-process adapters'
        : `[chat] bundled Slack/Discord workers rejected (${error instanceof Error ? error.message : String(error)}); using the in-process adapters`)
      return []
    })
    catalogs.set(packageRoot, catalog)
  }
  return catalog
}
