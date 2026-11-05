import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'

const keySchema = z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/)
const valueSchema = z.unknown()
export type ExtensionJsonValue = unknown

/** Project and extension isolated storage. The extension id is part of the path and is never
 * accepted from a caller after construction, preventing cross-extension reads. */
export class ExtensionStorage {
  constructor(private readonly root: string, private readonly extensionId: string) {}
  private file() { return join(this.root, 'extensions', this.extensionId, 'storage.json') }
  private async read(): Promise<Record<string, ExtensionJsonValue>> {
    try {
      const parsed = JSON.parse(await readFile(this.file(), 'utf8'))
      return z.record(z.string(), valueSchema).parse(parsed)
    } catch { return {} }
  }
  async get(key: string): Promise<ExtensionJsonValue | undefined> {
    keySchema.parse(key)
    return (await this.read())[key]
  }
  async set(key: string, value: ExtensionJsonValue): Promise<void> {
    keySchema.parse(key); valueSchema.parse(value)
    const values = await this.read(); values[key] = value
    const file = this.file(); await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.tmp-${process.pid}`
    await writeFile(tmp, JSON.stringify(values), { mode: 0o600 }); await rename(tmp, file)
  }
}
