import { ExtensionTaskEventBus } from '../extensions/events.ts'
import type { RunRecord } from '../runs/store.ts'
import { Hono, type Context, type Next } from 'hono'
import { extensionUninstallQuerySchema, extensionFormsResponseSchema, extensionEnableInputSchema, extensionIdParamsSchema, extensionPanelParamsSchema, extensionCommandParamsSchema, extensionsResponseSchema, extensionActionResponseSchema, extensionPanelSchema, extensionRecordSchema, extensionPrepareInstallInputSchema, extensionPrepareInstallResponseSchema, extensionCommitInstallInputSchema, extensionInvokeInputSchema, extensionMutationResponseSchema } from '@open-mercato/cezar-contract'
import { queryZodValidator, jsonZodValidator, paramZodValidator } from './validators.ts'
import { ExtensionManager } from '../extensions/manager.ts'
import type { ProjectContext } from './project-context.ts'
import { bundledProviderCatalog, type BundledProviderManifest } from '../extensions/bundled-catalog.ts'

type Env = { Variables: { project: ProjectContext } }
const managers = new WeakMap<ProjectContext, ExtensionManager>()
const cleanups = new WeakMap<ProjectContext, () => void>()
type BundledWorkerState = { mode: 'worker' | 'compatibility'; providers: readonly BundledProviderManifest[] }
const bundledStates = new WeakMap<ProjectContext, BundledWorkerState>()
/** `context.logger` lands in the server log, already redacted, capped per extension so a
 *  chatty worker cannot flood it. */
export function extensionLogger(projectId: string, write = (level: 'info' | 'error', line: string) => level === 'error' ? console.error(line) : console.info(line), now = Date.now) {
  const windows = new Map<string, { start: number; count: number }>()
  return (level: 'info' | 'error', message: string, extensionId: string) => {
    const window = windows.get(extensionId)
    if (!window || now() - window.start >= 60_000) windows.set(extensionId, { start: now(), count: 1 })
    else if (++window.count > 100) { if (window.count === 101) write('error', `[extension ${extensionId}] log rate limit reached; dropping messages for a minute`); return }
    write(level, `[extension ${extensionId}] (${projectId}) ${message.slice(0, 2000)}`)
  }
}

function manager(project: ProjectContext): ExtensionManager {
  let value = managers.get(project)
  if (!value) {
    const events = new ExtensionTaskEventBus()
    value = new ExtensionManager(project.dataDir, project.id, project.root, {
      events,
      listTasks: async () => project.store.listRuns().map(run => ({ id: run.id, title: run.title, status: run.status })),
      log: extensionLogger(project.id),
    })
    const onRun = (run: RunRecord) => events.publish({ type: 'updated', task: { id: run.id, title: run.title, status: run.status } })
    project.store.on('run', onRun)
    cleanups.set(project, () => project.store.off('run', onRun))
    managers.set(project, value)
  }
  return value
}

/** Why extension code may not run here, or undefined when it may. */
export type ExtensionsUnavailable = () => string | undefined
const always: ExtensionsUnavailable = () => undefined

/** Installing or running extension code is a local-machine capability, like agent-config writes
 *  (hosted cockpits refuse it), and `CEZ_EXTENSIONS=0` turns it off everywhere. */
export function extensionsUnavailableReason(env: NodeJS.ProcessEnv, localHandoff: boolean): string | undefined {
  if (env.CEZ_EXTENSIONS === '0') return 'extensions are turned off on this cockpit (CEZ_EXTENSIONS=0)'
  if (!localHandoff) return 'extensions are disabled in hosted mode; install and run them on the machine hosting cezar'
  return undefined
}

export async function restoreProjectExtensions(project: ProjectContext, unavailable: ExtensionsUnavailable = always): Promise<void> {
  if (!unavailable()) await manager(project).restore()
}

/**
 * Select the bundled chat owner for a project before webhook/chat recovery.
 *
 * The selection is deliberately separate from extension restoration: bundled
 * providers have reserved public ids and must never be registered through the
 * user-extension registry.  Missing artifacts are a normal development/
 * compatibility condition, so the in-process adapters remain the sole owner.
 */
export async function restoreBundledChatWorkers(project: ProjectContext, unavailable: ExtensionsUnavailable = always): Promise<BundledWorkerState> {
  const existing = bundledStates.get(project)
  if (existing) return existing
  if (unavailable()) {
    const state = { mode: 'compatibility' as const, providers: [] as readonly BundledProviderManifest[] }
    bundledStates.set(project, state)
    return state
  }
  // Verifies and caches the catalog before chat recovery, so a missing or tampered artifact is
  // logged once at boot; each bot's worker is activated by its chat service from this cache.
  const providers = await bundledProviderCatalog()
  const state = { mode: providers.length ? 'worker' as const : 'compatibility' as const, providers }
  bundledStates.set(project, state)
  return state
}

function requireLocal(unavailable: ExtensionsUnavailable) {
  return async (c: Context, next: Next) => {
    const reason = unavailable()
    if (reason) return c.json({ error: reason }, 409)
    await next()
  }
}

export async function closeProjectExtensions(project: ProjectContext): Promise<void> {
  // Clear the ownership decision before closing extension workers.  Bundled
  // workers are stopped by the chat service during its normal teardown; this
  // ordering ensures a subsequent project activation can never reuse a stale
  // worker decision or run both owners concurrently.
  bundledStates.delete(project)
  const value = managers.get(project)
  cleanups.get(project)?.()
  cleanups.delete(project)
  managers.delete(project)
  await value?.close()
}

/** Project-scoped extension API. Actions are always declared in the manifest and execute in a
 * short-lived worker with a narrow, immutable host context. */
export function extensionRoutes(unavailable: ExtensionsUnavailable = always) {
  const local = requireLocal(unavailable)
  return new Hono<Env>()
    .get('/extensions/access', async c => c.json(extensionsResponseSchema.parse({ extensions: await manager(c.get('project')).list() })))
    .post('/extensions/:extensionId/enable', local, paramZodValidator(extensionIdParamsSchema), jsonZodValidator(extensionEnableInputSchema), async c => {
      try {
        const record = await manager(c.get('project')).setEnabled(c.req.valid('param').extensionId, true, c.req.valid('json').integrity)
        return record ? c.json(extensionRecordSchema.parse(record)) : c.json({ error: 'extension not found' }, 404)
      } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension could not be enabled' }, 400) }
    })
    .post('/extensions/:extensionId/disable', paramZodValidator(extensionIdParamsSchema), async c => {
      const record = await manager(c.get('project')).setEnabled(c.req.valid('param').extensionId, false)
      return record ? c.json(extensionRecordSchema.parse(record)) : c.json({ error: 'extension not found' }, 404)
    })
    // A failed worker or a bad reply is an expected state here, not a server fault (M3, review 60da1c9e).
    .get('/extensions/:extensionId/forms', local, paramZodValidator(extensionIdParamsSchema), async c => {
      try { return c.json(extensionFormsResponseSchema.parse({ forms: await manager(c.get('project')).forms(c.req.valid('param').extensionId) }), 200) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension forms could not be loaded' }, 400) }
    })
    .get('/extensions/:extensionId/panels/:panelId', local, paramZodValidator(extensionPanelParamsSchema), async c => {
      const { extensionId, panelId } = c.req.valid('param')
      try {
        const extensions = manager(c.get('project'))
        const enabled = (await extensions.list()).some(item => item.manifest.id === extensionId && item.enabled)
        const panel = enabled ? await extensions.panel(extensionId, panelId) : undefined
        return panel ? c.json(extensionPanelSchema.parse(panel), 200) : c.json({ error: 'extension panel not found' }, 404)
      } catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension panel could not be loaded' }, 400) }
    })
    .post('/extensions/:extensionId/commands/:commandId/invoke', local, paramZodValidator(extensionCommandParamsSchema), jsonZodValidator(extensionInvokeInputSchema), async c => {
      const { extensionId, commandId } = c.req.valid('param'); try { return c.json(extensionActionResponseSchema.parse(await manager(c.get('project')).invoke(extensionId, commandId, c.req.valid('json').input))) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension command failed' }, 400) }
    })

}

/** Software installation is global; access, commands and data remain project-scoped. */
export function globalExtensionRoutes(project: ProjectContext, unavailable: ExtensionsUnavailable = always) {
  const local = requireLocal(unavailable)
  return new Hono()
    .get('/extensions', async c => c.json(extensionsResponseSchema.parse({ extensions: await manager(project).installed() })))
    .post('/extensions/:extensionId/prepare-update', local, paramZodValidator(extensionIdParamsSchema), async c => {
      try { return c.json(extensionPrepareInstallResponseSchema.parse(await manager(project).prepareUpdate(c.req.valid('param').extensionId))) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension could not be inspected' }, 400) }
    })
    .post('/extensions/prepare-install', local, jsonZodValidator(extensionPrepareInstallInputSchema), async c => {
      try { return c.json(extensionPrepareInstallResponseSchema.parse(await manager(project).prepare(c.req.valid('json').source))) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension could not be inspected' }, 400) }
    })
    .post('/extensions/commit-install', local, jsonZodValidator(extensionCommitInstallInputSchema), async c => {
      try { return c.json(extensionRecordSchema.parse(await manager(project).commit(c.req.valid('json').preparedId)), 201) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension could not be installed' }, 400) }
    })
    .delete('/extensions/:extensionId', local, paramZodValidator(extensionIdParamsSchema), queryZodValidator(extensionUninstallQuerySchema), async c => {
      const removed = await manager(project).uninstall(c.req.valid('param').extensionId, c.req.valid('query').removeData === 'true')
      return removed ? c.json(extensionMutationResponseSchema.parse({ ok: true })) : c.json({ error: 'extension not found' }, 404)
    })
}

export const subscribeExtensionChanges = (listener: () => void) => ExtensionManager.subscribe(listener)
