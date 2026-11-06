import { ExtensionTaskEventBus } from '../extensions/events.ts'
import type { RunRecord } from '../runs/store.ts'
import { Hono, type Context, type Next } from 'hono'
import { extensionUninstallQuerySchema, extensionFormsResponseSchema, extensionEnableInputSchema, extensionActionInputSchema, extensionIdParamsSchema, extensionPanelParamsSchema, extensionCommandParamsSchema, extensionsResponseSchema, extensionActionResponseSchema, extensionPanelsResponseSchema, extensionRecordSchema, extensionPrepareInstallInputSchema, extensionPrepareInstallResponseSchema, extensionCommitInstallInputSchema, extensionInvokeInputSchema, extensionMutationResponseSchema } from '@open-mercato/cezar-contract'
import { queryZodValidator, jsonZodValidator, paramZodValidator } from './validators.ts'
import { ExtensionManager } from '../extensions/manager.ts'
import type { ProjectContext } from './project-context.ts'

type Env = { Variables: { project: ProjectContext } }
const managers = new WeakMap<ProjectContext, ExtensionManager>()
const cleanups = new WeakMap<ProjectContext, () => void>()
function manager(project: ProjectContext): ExtensionManager {
  let value = managers.get(project)
  if (!value) {
    const events = new ExtensionTaskEventBus()
    value = new ExtensionManager(project.dataDir, project.id, project.root, {
      events,
      listTasks: async () => project.store.listRuns().map(run => ({ id: run.id, title: run.title, status: run.status })),
    })
    const onRun = (run: RunRecord) => events.publish({ type: 'updated', task: { id: run.id, title: run.title, status: run.status } })
    project.store.on('run', onRun)
    cleanups.set(project, () => project.store.off('run', onRun))
    managers.set(project, value)
  }
  return value
}

export async function restoreProjectExtensions(project: ProjectContext, localOnly: () => boolean = () => true): Promise<void> {
  // A hosted cockpit never runs extension code (same boundary as agent-config writes).
  if (localOnly()) await manager(project).restore()
}

const HOSTED_REFUSAL = { error: 'extensions are disabled in hosted mode; install and run them on the machine hosting cezar' }
/** Running or installing extension code is a local-machine capability, like agent-config writes. */
function requireLocal(localOnly: () => boolean) {
  return async (c: Context, next: Next) => {
    if (!localOnly()) return c.json(HOSTED_REFUSAL, 409)
    await next()
  }
}

export async function closeProjectExtensions(project: ProjectContext): Promise<void> {
  const value = managers.get(project)
  cleanups.get(project)?.()
  cleanups.delete(project)
  managers.delete(project)
  await value?.close()
}

/** Project-scoped extension API. Actions are always declared in the manifest and execute in a
 * short-lived worker with a narrow, immutable host context. */
export function extensionRoutes(localOnly: () => boolean = () => true) {
  const local = requireLocal(localOnly)
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
    .get('/extensions/:extensionId/forms', paramZodValidator(extensionIdParamsSchema), async c => c.json(extensionFormsResponseSchema.parse({ forms: await manager(c.get('project')).forms(c.req.valid('param').extensionId) })))
    .get('/extensions/panels', async c => c.json(extensionPanelsResponseSchema.parse({ panels: await manager(c.get('project')).panels() })))
    .get('/extensions/:extensionId/panels/:panelId', local, paramZodValidator(extensionPanelParamsSchema), async c => {
      const { extensionId, panelId } = c.req.valid('param'); const record = (await manager(c.get('project')).list()).find(item => item.manifest.id === extensionId && item.enabled)
      const panel = record ? await manager(c.get('project')).panel(extensionId, panelId) : undefined; return panel ? c.json(panel) : c.json({ error: 'extension panel not found' }, 404)
    })
    .post('/extensions/:extensionId/commands/:commandId/invoke', local, paramZodValidator(extensionCommandParamsSchema), jsonZodValidator(extensionInvokeInputSchema), async c => {
      const { extensionId, commandId } = c.req.valid('param'); try { return c.json(extensionActionResponseSchema.parse(await manager(c.get('project')).invoke(extensionId, commandId, c.req.valid('json').input))) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension command failed' }, 400) }
    })
    .post('/extensions/:extensionId/actions', local, paramZodValidator(extensionIdParamsSchema), jsonZodValidator(extensionActionInputSchema), async c => {
      try { return c.json(extensionActionResponseSchema.parse(await manager(c.get('project')).invoke(c.req.valid('param').extensionId, c.req.valid('json').actionId, c.req.valid('json').input))) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension action failed' }, 400) }
    })

}

/** Software installation is global; access, commands and data remain project-scoped. */
export function globalExtensionRoutes(project: ProjectContext, localOnly: () => boolean = () => true) {
  const local = requireLocal(localOnly)
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
