import { Hono } from 'hono'
import { extensionActionInputSchema, extensionIdParamsSchema, extensionsResponseSchema, extensionActionResponseSchema, installExtensionInputSchema, extensionPanelsResponseSchema, extensionRecordSchema } from '@open-mercato/cezar-contract'
import { jsonZodValidator, paramZodValidator } from './validators.ts'
import { ExtensionManager } from '../extensions/manager.ts'
import type { ProjectContext } from './project-context.ts'

type Env = { Variables: { project: ProjectContext } }
const managers = new WeakMap<ProjectContext, ExtensionManager>()
function manager(project: ProjectContext): ExtensionManager {
  let value = managers.get(project)
  if (!value) { value = new ExtensionManager(project.dataDir, project.id, project.root); managers.set(project, value) }
  return value
}

/** Project-scoped extension API. Actions are always declared in the manifest and execute in a
 * short-lived worker with a narrow, immutable host context. */
export function extensionRoutes() {
  return new Hono<Env>()
    .get('/extensions', async c => c.json(extensionsResponseSchema.parse({ extensions: await manager(c.get('project')).list() })))
    .post('/extensions', jsonZodValidator(installExtensionInputSchema), async c => {
      try { return c.json(extensionRecordSchema.parse(await manager(c.get('project')).install(c.req.valid('json').source)), 201) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension could not be installed' }, 400) }
    })
    .post('/extensions/:extensionId/enable', paramZodValidator(extensionIdParamsSchema), async c => {
      const record = await manager(c.get('project')).setEnabled(c.req.valid('param').extensionId, true)
      return record ? c.json(extensionRecordSchema.parse(record)) : c.json({ error: 'extension not found' }, 404)
    })
    .post('/extensions/:extensionId/disable', paramZodValidator(extensionIdParamsSchema), async c => {
      const record = await manager(c.get('project')).setEnabled(c.req.valid('param').extensionId, false)
      return record ? c.json(extensionRecordSchema.parse(record)) : c.json({ error: 'extension not found' }, 404)
    })
    .get('/extensions/panels', async c => c.json(extensionPanelsResponseSchema.parse({ panels: await manager(c.get('project')).panels() })))
    .post('/extensions/:extensionId/actions', paramZodValidator(extensionIdParamsSchema), jsonZodValidator(extensionActionInputSchema), async c => {
      try { return c.json(extensionActionResponseSchema.parse(await manager(c.get('project')).invoke(c.req.valid('param').extensionId, c.req.valid('json').actionId, c.req.valid('json').input))) }
      catch (error) { return c.json({ error: error instanceof Error ? error.message : 'extension action failed' }, 400) }
    })
}
