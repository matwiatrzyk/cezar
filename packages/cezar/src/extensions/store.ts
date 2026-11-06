import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { extensionRecordSchema, type ExtensionRecord } from '@open-mercato/cezar-contract'

export class ExtensionStore {
  private mutex: Promise<void> = Promise.resolve()
  constructor(private readonly file: string) {}
  async list(): Promise<ExtensionRecord[]> { try { const raw: unknown = JSON.parse(await readFile(this.file, 'utf8')); return Array.isArray(raw) ? raw.flatMap(item => { const p = extensionRecordSchema.safeParse(item); return p.success ? [p.data] : [] }) : [] } catch { return [] } }
  async replace(records: ExtensionRecord[]): Promise<void> {
    const run = this.mutex.then(async () => { await mkdir(dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp-${process.pid}-${Date.now()}`; await writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 }); await rename(tmp, this.file) })
    this.mutex = run.then(() => undefined, () => undefined); await run
  }
  async update(fn: (records: ExtensionRecord[]) => ExtensionRecord[]): Promise<ExtensionRecord[]> { const records = await this.list(); const next = fn(records); await this.replace(next); return next }
}
