import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extensionRecordSchema } from '@open-mercato/cezar-contract'
import { ExtensionInstaller } from './installer.ts'
import { prepareUpdate, snapshotExtensionState } from './updates.ts'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('requiresApprovalForAddedPermissions and cleans rejected staging', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-update-')); roots.push(root)
  const source = join(root, 'source'); await mkdir(source)
  const current = extensionRecordSchema.parse({ manifest: { id: 'fixture', name: 'Fixture', version: '1.0.0', apiVersion: '0.1', entry: 'index.mjs' }, source, enabled: false, installedAt: 'now' })
  await writeFile(join(source, 'extension.json'), JSON.stringify({ ...current.manifest, permissions: ['task.create'] }))
  await writeFile(join(source, 'index.mjs'), '')
  const installer = new ExtensionInstaller(join(root, 'home'))
  await expect(prepareUpdate(installer, current, source)).rejects.toThrow('require approval')
  expect(await readdir(join(root, 'home/extensions/.staging'))).toEqual([])
  const prepared = await prepareUpdate(installer, current, source, true)
  await installer.discardInstall(prepared)
})
it('preserves old local state on failed update and restores absence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'extension-update-')); roots.push(root)
  const state = join(root, 'state'); await mkdir(state)
  await writeFile(join(state, 'data'), 'old')
  const snapshot = await snapshotExtensionState(state)
  await writeFile(join(state, 'data'), 'migration failed')
  await snapshot.restore()
  expect(await readFile(join(state, 'data'), 'utf8')).toBe('old')
  const absent = join(root, 'absent')
  const empty = await snapshotExtensionState(absent)
  await mkdir(absent)
  await empty.restore()
  expect(await readdir(root)).not.toContain('absent')
})
