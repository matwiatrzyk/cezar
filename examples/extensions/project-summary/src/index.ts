import { defineExtension, type ExtensionTaskSummary } from '@open-mercato/cezar-extension-sdk'

export default defineExtension({
  async activate(context) {
    let tasks: ExtensionTaskSummary[] = await context.tasks.list()
    const refresh = async () => { tasks = await context.tasks.list() }
    const subscriptions = [
      context.commands.register('refresh', async () => {
        await refresh()
        return { message: 'Summary refreshed' }
      }),
      context.panels.register('summary', () => ({
        id: 'summary', title: 'Project summary',
        blocks: [{ type: 'table', columns: ['Task', 'Status'], rows: tasks.map(task => [task.title, task.status]).slice(0, 100) }],
        actions: [{ id: 'refresh', label: 'Refresh summary' }],
      })),
      context.taskEvents.subscribe(refresh),
    ]
    return { async dispose() { for (const subscription of subscriptions) await subscription.dispose() } }
  },
})
