import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { extensionStorageKeySchema } from '@open-mercato/cezar-contract'
import { atomicLifecycleWrite, withLifecycleFileLock } from '../worktree-lifecycle/store.ts'

const valueSchema = z.json()
export type ExtensionJsonValue = z.infer<typeof valueSchema>

/** One locked, JSON-only store per project and extension. */
export class ExtensionStorage {
  constructor(private readonly root: string, private readonly extensionId: string) {}
  private file() { return join(this.root, 'extensions', this.extensionId, 'storage.json') }
  private async read(): Promise<Record<string, ExtensionJsonValue>> {
    try { return z.record(z.string(), valueSchema).parse(JSON.parse(await readFile(this.file(), 'utf8'))) }
    catch { return {} }
  }
  async get(key: string): Promise<ExtensionJsonValue | undefined> {
    extensionStorageKeySchema.parse(key)
    return (await this.read())[key]
  }
  async set(key: string, input: unknown, ensureActive: () => void = () => {}): Promise<void> {
    extensionStorageKeySchema.parse(key)
    const value = valueSchema.parse(input)
    const file = this.file()
    await mkdir(dirname(file), { recursive: true })
    await withLifecycleFileLock(`${file}.lock`, async () => {
      const values = await this.read()
      ensureActive()
      values[key] = value
      await atomicLifecycleWrite(file, values, ensureActive)
    })
  }
}

/** Host-owned key inventory, separate from the extension's editable storage. */
export async function extensionSecretNames(root: string, id: string): Promise<string[]> {
  try { return z.array(z.string().regex(/^EXTENSION_[A-F0-9]{64}$/)).parse(JSON.parse(await readFile(join(root, 'extensions', id, 'secret-names.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}
export async function rememberExtensionSecret(root: string, id: string, name: string, active: () => void): Promise<void> {
  const file = join(root, 'extensions', id, 'secret-names.json')
  await mkdir(dirname(file), { recursive: true })
  await withLifecycleFileLock(`${file}.lock`, async () => {
    const names = await extensionSecretNames(root, id); active()
    if (!names.includes(name)) await atomicLifecycleWrite(file, [...names, name], active)
  })
}
