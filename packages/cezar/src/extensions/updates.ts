import { cp, lstat, mkdtemp, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { ExtensionRecord } from '@open-mercato/cezar-contract'
import { ExtensionInstaller, artifactIntegrity, type PreparedInstall } from './installer.ts'
import { withLifecycleFileLock } from '../worktree-lifecycle/store.ts'

export async function prepareUpdate(installer: ExtensionInstaller, current: ExtensionRecord | undefined, source: string, approveAddedPermissions = false): Promise<PreparedInstall> {
  const prepared = await installer.prepareInstall(source)
  try {
    if (current && prepared.manifest.id !== current.manifest.id) throw new Error('extension id cannot change during update')
    if (!approveAddedPermissions && current && prepared.manifest.permissions.some(permission => !current.manifest.permissions.includes(permission))) throw new Error('new extension permissions require approval')
    return prepared
  } catch (error) { await installer.discardInstall(prepared); throw error }
}

/** Snapshot only the caller-owned extension state directory, after stopping its runtime.
 * Keep the old immutable artifact path in the manager until activation succeeds. */
export async function snapshotExtensionState(stateDir: string): Promise<{ restore(): Promise<void>; discard(): Promise<void> }> {
  await mkdir(dirname(stateDir), { recursive: true })
  const snapshot = await mkdtemp(join(dirname(stateDir), '.extension-rollback-'))
  const backup = join(snapshot, 'state')
  const displaced = join(snapshot, 'failed')
  let consumed = false
  const exists = await lstat(stateDir).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  try {
    if (exists) {
      if (!exists.isDirectory() || exists.isSymbolicLink()) throw new Error('extension state must be a directory')
      await artifactIntegrity(stateDir)
      await cp(stateDir, backup, { recursive: true })
    }
  } catch (error) { await rm(snapshot, { recursive: true, force: true }); throw error }
  return {
    async restore() {
      if (consumed) throw new Error('extension snapshot already consumed')
      await withLifecycleFileLock(`${stateDir}.lock`, async () => {
        let moved = false
        try { await rename(stateDir, displaced); moved = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        try { if (exists) await rename(backup, stateDir) }
        catch (error) { if (moved) await rename(displaced, stateDir); throw error }
        consumed = true
        await rm(snapshot, { recursive: true, force: true })
      })
    },
    async discard() { consumed = true; await rm(snapshot, { recursive: true, force: true }) },
  }
}
