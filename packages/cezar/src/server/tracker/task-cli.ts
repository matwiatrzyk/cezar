import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { trackerContextSchema, trackerOperationInputSchema, trackerOperationResultSchema } from '@open-mercato/cezar-contract';

export async function runTrackerCommand(args: string[], env: NodeJS.ProcessEnv = process.env, io = { fetch, log: console.log, error: console.error }): Promise<number> {
  try {
    const [command, ...rest] = args;
    if (!command || command === '--help') {
      io.log('cez tracker read | comment --id <UUID> --body-file <path> | transition --id <UUID> --transition <id> --expected-status <id>');
      return 0;
    }
    if (!env.CEZ_API_URL || !env.CEZ_TRACKER_CAPABILITY) throw new Error('Tracker access is available only inside an authorized tracker task.');
    const base = new URL(env.CEZ_API_URL);
    if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('Tracker operations require the local cockpit.');
    const scope = env.CEZ_PROJECT_ID ? `/p/${encodeURIComponent(env.CEZ_PROJECT_ID)}` : '';
    const url = `${base.origin}/api/v1${scope}/tracker/task`;
    const headers = { Authorization: `Bearer ${env.CEZ_TRACKER_CAPABILITY}`, 'Content-Type': 'application/json' };
    let response: Response;
    if (command === 'read' && !rest.length) response = await io.fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(40000) });
    else {
      const { values } = parseArgs({ args: rest, options: { id: { type: 'string' }, 'body-file': { type: 'string' }, transition: { type: 'string' }, 'expected-status': { type: 'string' } } });
      const action = command === 'comment' ? { kind: 'comment', body: await readFile(values['body-file'] ?? '', 'utf8') }
        : command === 'transition' ? { kind: 'transition', transitionId: values.transition, expectedStatusId: values['expected-status'] } : null;
      const input = trackerOperationInputSchema.parse({ operationId: values.id, action });
      response = await io.fetch(url, { method: 'POST', headers, body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(60000) });
    }
    if (!response.ok) throw new Error(`Tracker request refused (${response.status}). Check task permissions and connection.`);
    const data: unknown = await response.json();
    const result = command === 'read' ? trackerContextSchema.parse(data) : trackerOperationResultSchema.parse(data);
    io.log(JSON.stringify(result, null, 2));
    return 'status' in result && result.status !== 'completed' ? 2 : 0;
  } catch {
    io.error('Tracker command failed. Verify arguments, task access and connection. A failed write may have succeeded remotely: reuse its operation ID, never blindly submit a new one.');
    return 2;
  }
}
