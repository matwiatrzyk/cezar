import { cp, lstat, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { extensionManifestSchema, type ExtensionManifest } from '@open-mercato/cezar-contract'
import { cezarHomeDir } from '../paths.ts'

export type PreparedInstall = { id: string; source: string; artifactDir: string; manifest: ExtensionManifest }
export class ExtensionInstaller {
  constructor(private readonly home = cezarHomeDir()) {}
  async prepareInstall(source: string): Promise<PreparedInstall> {
    const root = await realpath(source); const manifest = await this.readManifest(root)
    const entry = resolve(root, manifest.entry); if (relative(root, entry).startsWith('..') || !(await lstat(entry)).isFile()) throw new Error('extension entry must stay inside its installed directory')
    const staging = join(this.home, 'extensions', '.staging', `${manifest.id}-${Date.now()}-${process.pid}`); await mkdir(staging, { recursive: true }); await cp(root, staging, { recursive: true, dereference: false });
    return { id: manifest.id, source, artifactDir: staging, manifest }
  }
  async commitInstall(prepared: PreparedInstall): Promise<{ id: string; path: string; manifest: ExtensionManifest }> {
    const target = join(this.home, 'extensions', prepared.id, prepared.manifest.version); await mkdir(resolve(target, '..'), { recursive: true }); await cp(prepared.artifactDir, target, { recursive: true, errorOnExist: false }); await rm(prepared.artifactDir, { recursive: true, force: true }); return { id: prepared.id, path: target, manifest: prepared.manifest }
  }
  private async readManifest(root: string): Promise<ExtensionManifest> { let raw: unknown; try { raw = JSON.parse(await readFile(join(root, 'extension.json'), 'utf8')) } catch { const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { cezarExtension?: unknown }; raw = pkg.cezarExtension } return extensionManifestSchema.parse(raw) }
}
