import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { trackerActionSchema, trackerOperationResultSchema, type TrackerOperationInput, type TrackerOperationResult } from '@open-mercato/cezar-contract';
import type { RunRecord } from '../../runs/store.ts';
import { renameWithRetry } from '../../fs-rename.ts';
import { createTrackerService } from './index.ts';
import { TrackerAgentBindingError } from './agent-credentials.ts';

export type TrackerTaskBinding = NonNullable<RunRecord['automationTracker']>;
export async function taskTracker(root: string, binding: TrackerTaskBinding) {
  if (!binding.access || !binding.issueId || !binding.association) {
    throw new TrackerAgentBindingError('This tracker automation requires migration. Review its tracker access in the automation editor and create a new run.');
  }
  const driver = await createTrackerService().driver(root, join(root, '.ai/cezar'));
  if ('available' in driver) throw new TrackerAgentBindingError(driver.reason);
  const a = driver.association, b = binding.association;
  if (a.kind !== b.kind || a.connectionId !== b.connectionId || a.source.id !== b.source.id || a.source.webUrl !== b.source.webUrl || a.externalId !== b.externalId || !driver.context) throw new TrackerAgentBindingError();
  return driver;
}

export async function trackerTaskContext(root: string, binding: TrackerTaskBinding) {
  const driver = await taskTracker(root, binding);
  try {
    const context = await driver.context!(binding.issueId!);
    if (context.issueId !== binding.issueId) throw new TrackerAgentBindingError();
    return context;
  } catch (error) {
    if (error instanceof TrackerAgentBindingError) throw error;
    throw new TrackerAgentBindingError('Could not read complete tracker context. Check the connection, permissions and issue size before retrying.');
  }
}

const receiptSchema = z.object({ fingerprint: z.string(), issueId: z.string(), connectionId: z.string().optional(), action: trackerActionSchema, updatedAt: z.string(), result: trackerOperationResultSchema });
// Writes are serialized across local cockpit processes. A crashed writer leaves an unknown
// receipt. Only a dead owner may be reaped, and retrying its ID never resends the write.
export async function executeTrackerOperation(root: string, dataDir: string, runId: string, binding: TrackerTaskBinding, input: TrackerOperationInput, stillAuthorized: () => boolean = () => true): Promise<TrackerOperationResult> {
  if (!binding.access?.writes.includes(input.action.kind)) return { operationId: input.operationId, status: 'rejected', message: 'This automation did not authorize this operation.' };
  const driver = await taskTracker(root, binding);
  if (!driver.act) return { operationId: input.operationId, status: 'rejected', message: 'Tracker writes are unavailable.' };
  const directory = join(dataDir, 'runs', runId + '.tracker-operations');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, input.operationId + '.json');
  const scope = [binding.association?.kind, binding.association?.source, binding.association?.externalId, binding.association?.connectionId, binding.issueId];
  const fingerprint = createHash('sha256').update(JSON.stringify([scope, input.action])).digest('hex');
  const existing = async () => {
    try {
      const record = receiptSchema.parse(JSON.parse(await fs.readFile(path, 'utf8')));
      return record.fingerprint === fingerprint ? record.result : { operationId: input.operationId, status: 'rejected' as const, message: 'This operation ID already belongs to another payload.' };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  };
  const prior = await existing();
  if (prior) return prior;
  // Lock by issue and connection, not by operation ID: two different actions cannot race here.
  const lock = join(dataDir, 'runs', `tracker-${createHash('sha256').update(JSON.stringify(scope)).digest('hex')}.lock`);
  const owner = join(lock, String(process.pid));
  for (let attempt = 0; ; attempt++) {
    try { await fs.mkdir(lock, { mode: 0o700 }); await fs.writeFile(owner, '', { flag: 'wx', mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owners = await fs.readdir(lock).catch(() => []);
      if (attempt === 0 && owners.length === 1 && /^[1-9][0-9]*$/.test(owners[0]!)) {
        try { process.kill(Number(owners[0]), 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            try { await fs.unlink(join(lock, owners[0]!)); await fs.rmdir(lock); } catch {}
            continue;
          }
        }
      }
      if (attempt === 0 && owners.length === 0 && Date.now() - (await fs.stat(lock)).mtimeMs > 60000) {
        await fs.rmdir(lock).catch(() => {}); continue;
      }
      return { operationId: input.operationId, status: 'unknown', message: 'Another operation is active or was interrupted. Inspect the tracker before taking further action.' };
    }
  }
  const save = async (result: TrackerOperationResult) => {
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ fingerprint, issueId: binding.issueId, connectionId: binding.association?.connectionId, action: input.action, updatedAt: new Date().toISOString(), result })); await file.sync(); } finally { await file.close(); }
      await renameWithRetry(temporary, path);
      if (process.platform !== 'win32') {
        const folder = await fs.open(directory, 'r');
        try { await folder.sync(); } finally { await folder.close(); }
      }
    } finally { await fs.unlink(temporary).catch(() => {}); }
  };
  try {
    const raced = await existing();
    if (raced) return raced;
    // Persist BEFORE issuing a request. A crash or failed final save cannot cause a blind retry.
    const unknown: TrackerOperationResult = { operationId: input.operationId, status: 'unknown', message: 'Outcome is uncertain. Inspect the issue; do not retry under a new ID without confirming the previous outcome.' };
    await save(unknown);
    try { await driver.act(binding.issueId!, input.action, async () => { if (!stillAuthorized()) throw new TrackerAgentBindingError('Task authorization expired before the write.'); }); }
    catch { return unknown; }
    const result: TrackerOperationResult = { operationId: input.operationId, status: 'completed', message: 'Tracker confirmed the operation.' };
    await save(result);
    return result;
  } finally { await fs.unlink(owner).catch(() => {}); await fs.rmdir(lock).catch(() => {}); }
}
