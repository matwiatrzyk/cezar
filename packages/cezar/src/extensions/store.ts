import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { extensionRecordSchema, type ExtensionRecord } from '@open-mercato/cezar-contract'
import { cezarHomeDir } from '../paths.ts'
import { assertLifecyclePath, atomicLifecycleWrite, withLifecycleFileLock } from '../worktree-lifecycle/store.ts'

/** Global installation registry. Project enablement is owned by the manager. */
export class ExtensionStore {
  constructor(private readonly file = join(cezarHomeDir(), 'extensions', 'registry.json')) {}
  async list(): Promise<ExtensionRecord[]> {
    const raw = await this.readRaw()
    return raw.flatMap(item => {
      const parsed = extensionRecordSchema.safeParse(item)
      return parsed.success ? [parsed.data] : []
    })
  }
  private async readRaw(): Promise<unknown[]> {
    try {
      await assertLifecyclePath(this.file, dirname(this.file))
      const raw: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      return Array.isArray(raw) ? raw : []
    } catch { return [] }
  }
  async replace(records: ExtensionRecord[]): Promise<void> { await this.update(() => records) }
  async update(fn: (records: ExtensionRecord[]) => ExtensionRecord[]): Promise<ExtensionRecord[]> {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
    await assertLifecyclePath(this.file, dirname(this.file))
    return withLifecycleFileLock(`${this.file}.lock`, async () => {
      const raw = await this.readRaw()
      const records = raw.flatMap(item => {
        const parsed = extensionRecordSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      })
      const next = fn(records).map(record => extensionRecordSchema.parse(record))
      const invalid = raw.filter(item => !extensionRecordSchema.safeParse(item).success)
      await atomicLifecycleWrite(this.file, [...next, ...invalid])
      return next
    })
  }
}
