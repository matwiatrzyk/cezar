/** Discord application-command definitions and the pure task-choice formatter.
 *
 * The gateway owns the interaction ACK and the chat conversation owns command
 * execution. Keeping these values provider-local prevents Discord wire types
 * from leaking into the shared command semantics.
 */
export interface DiscordApplicationCommand {
  name: 'tasks'; description: string; type: 1;
  options: [{ name: 'task'; description: string; type: 3; required: false; autocomplete: true }];
}

export interface DiscordTaskChoiceInput { id: string; title?: string }
export interface DiscordTaskChoice { name: string; value: string }
export const discordCommandInteractionCallback = (choices: readonly DiscordTaskChoice[]) => ({ type: 8, data: { choices: choices.slice(0, 25) } });

export function discordApplicationCommands(): readonly DiscordApplicationCommand[] {
  return [{
    name: 'tasks', description: 'List this project’s tasks', type: 1,
    options: [{ name: 'task', description: 'Open a task or show its status', type: 3, required: false, autocomplete: true }],
  }];
}

/** Format at most Discord’s 25 choices, preserving caller order (newest first). */
export function discordTaskChoices(tasks: readonly DiscordTaskChoiceInput[], query: string): DiscordTaskChoice[] {
  const needle = query.trim().toLocaleLowerCase();
  const matching = tasks.filter(task => !needle || task.id.toLocaleLowerCase().includes(needle) || (task.title ?? '').toLocaleLowerCase().includes(needle));
  const source = matching.length ? matching : tasks;
  return source.slice(0, 25).map(task => {
    const title = task.title?.trim();
    const label = title ? `${title} · ${task.id.slice(0, 8)}` : `Task · ${task.id}`;
    return { name: label.slice(0, 100), value: task.id.slice(0, 100) };
  });
}
