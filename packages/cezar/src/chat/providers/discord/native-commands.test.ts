import { describe, expect, it } from 'vitest';
import { discordApplicationCommands, discordTaskChoices } from './native-commands.ts';

describe('Discord native commands', () => {
  it('registers /tasks with an optional autocomplete task reference', () => {
    expect(discordApplicationCommands()).toEqual([
      {
        name: 'tasks',
        description: 'List this project’s tasks',
        type: 1,
        options: [{ name: 'task', description: 'Open a task or show its status', type: 3, required: false, autocomplete: true }],
      },
    ]);
  });

  it('returns deterministic, bounded task choices for a partial query', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({ id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, title: `Task ${i}` }));
    expect(discordTaskChoices(tasks, 'task 2')).toEqual([
      { name: 'Task 2 · 00000000', value: tasks[2]!.id },
      { name: 'Task 20 · 00000000', value: tasks[20]!.id },
      { name: 'Task 21 · 00000000', value: tasks[21]!.id },
      { name: 'Task 22 · 00000000', value: tasks[22]!.id },
      { name: 'Task 23 · 00000000', value: tasks[23]!.id },
      { name: 'Task 24 · 00000000', value: tasks[24]!.id },
      { name: 'Task 25 · 00000000', value: tasks[25]!.id },
      { name: 'Task 26 · 00000000', value: tasks[26]!.id },
      { name: 'Task 27 · 00000000', value: tasks[27]!.id },
      { name: 'Task 28 · 00000000', value: tasks[28]!.id },
      { name: 'Task 29 · 00000000', value: tasks[29]!.id },
    ]);
  });

  it('limits choices and falls back to the newest tasks when nothing matches', () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({ id: `${i + 1}`, title: '' }));
    expect(discordTaskChoices(tasks, 'no match')).toHaveLength(25);
    expect(discordTaskChoices(tasks, 'no match')[0]).toEqual({ name: 'Task · 30', value: '30' });
  });
});
