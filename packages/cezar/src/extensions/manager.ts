import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { Worker } from 'node:worker_threads'
import { extensionManifestSchema, extensionRecordSchema, type ExtensionManifest, type ExtensionPanel, type ExtensionRecord } from '@open-mercato/cezar-contract'

const require = createRequire(import.meta.url)
const registryName = 'extensions/registry.json'

export type ExtensionHost = Readonly<{ projectId: string; projectRoot: string; permissions: readonly string[] }>

/** Project-local extension registry and isolated action runner. The registry is deliberately
 * boring JSON so deleting it is a safe reset; manifests are validated before persistence. */
export class ExtensionManager {
  private records: ExtensionRecord[] = []
  private loaded = false
  constructor(private readonly dataDir: string, private readonly projectId: string, private readonly projectRoot: string) {}

  private path() { return join(this.dataDir, registryName) }
  private async load() {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(await readFile(this.path(), 'utf8')) as unknown
      if (Array.isArray(raw)) this.records = raw.flatMap(value => { const parsed = extensionRecordSchema.safeParse(value); return parsed.success ? [parsed.data] : [] })
    } catch { /* absent/corrupt state degrades to an empty registry */ }
  }
  private async save() {
    await mkdir(dirname(this.path()), { recursive: true })
    const tmp = `${this.path()}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(this.records, null, 2), { mode: 0o600 })
    await rename(tmp, this.path())
  }
  async list(): Promise<ExtensionRecord[]> { await this.load(); return this.records.map(record => ({ ...record, manifest: { ...record.manifest }, })) }

  async install(source: string): Promise<ExtensionRecord> {
    await this.load()
    const root = await this.resolveSource(source)
    let packageJson: { cezarExtension?: unknown } = {}
    try { packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { cezarExtension?: unknown } } catch { /* local folders may only carry extension.json */ }
    const manifestPath = join(root, 'extension.json')
    let raw: unknown = packageJson.cezarExtension
    try { raw = JSON.parse(await readFile(manifestPath, 'utf8')) } catch { /* package.json declaration is supported */ }
    const manifest = extensionManifestSchema.parse(raw)
    // Keep the user supplied source in the registry. Resolving it to an absolute
    // path here would leak local filesystem paths through the HTTP API.
    const record: ExtensionRecord = { manifest, source, installedAt: new Date().toISOString(), enabled: false }
    this.records = [...this.records.filter(item => item.manifest.id !== manifest.id), record]
    await this.save()
    return record
  }
  async setEnabled(id: string, enabled: boolean): Promise<ExtensionRecord | undefined> {
    await this.load(); const record = this.records.find(item => item.manifest.id === id); if (!record) return undefined
    record.enabled = enabled; await this.save(); return record
  }
  async panels(): Promise<ExtensionPanel[]> { return (await this.list()).filter(record => record.enabled).flatMap(record => record.manifest.panels) }
  async invoke(id: string, actionId: string, input?: Record<string, unknown>): Promise<{ ok: boolean; message?: string }> {
    await this.load(); const record = this.records.find(item => item.manifest.id === id && item.enabled); if (!record) throw new Error('extension is not enabled')
    if (!record.manifest.actions.some(action => action.id === actionId)) throw new Error('extension action is not declared')
    const root = await this.resolveSource(record.source)
    const entry = resolve(root, record.manifest.entry)
    const escaped = isAbsolute(record.manifest.entry) || relative(root, entry).startsWith('..')
    if (escaped) throw new Error('extension entry must stay inside its installed directory')
    if (!existsSync(entry)) throw new Error('extension entry is missing')
    return await runWorker(entry, { actionId, input, context: { projectId: this.projectId, projectRoot: this.projectRoot, permissions: record.manifest.permissions } })
  }
  private async resolveSource(source: string): Promise<string> {
    const candidate = resolve(this.projectRoot, source)
    if (existsSync(candidate)) return candidate
    try { return dirname(require.resolve(`${source}/package.json`, { paths: [this.projectRoot] })) } catch { throw new Error(`extension source not found: ${source}`) }
  }
}

function runWorker(entry: string, message: { actionId: string; input?: Record<string, unknown>; context: ExtensionHost }): Promise<{ ok: boolean; message?: string }> {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(`import { parentPort } from 'node:worker_threads'; import(${JSON.stringify(entry)}).then(async m => { const extension = m.default ?? m.extension ?? m; parentPort.on('message', async value => { if (!value.__bootstrap) return; try { const result = extension.onAction ? await extension.onAction(value.actionId, value.input, value.context) : undefined; parentPort.postMessage(result ?? {}); } catch (error) { parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }); } }); }).catch(error => parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }));`, { eval: true })
    const timer = setTimeout(() => { void worker.terminate(); reject(new Error('extension action timed out')) }, 10_000)
    worker.once('error', error => { clearTimeout(timer); reject(error) })
    worker.once('message', (value: unknown) => { clearTimeout(timer); void worker.terminate(); const result = value && typeof value === 'object' ? value as { error?: unknown; message?: unknown } : {}; if (result.error) reject(new Error(String(result.error))); else resolvePromise({ ok: true, ...(typeof result.message === 'string' ? { message: result.message } : {}) }) })
    worker.postMessage({ ...message, __bootstrap: true })
  })
}
