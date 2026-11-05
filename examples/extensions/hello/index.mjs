export async function onAction(actionId, input, context) {
  if (actionId !== 'hello') throw new Error('unknown action')
  return { message: `Hello from ${context.projectId}${input?.name ? `, ${input.name}` : ''}` }
}
