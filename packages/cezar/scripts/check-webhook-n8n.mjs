// Optional recipe acceptance test. Requires Docker; all requests stay inside --network none.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const exec = promisify(execFile);
const image = 'docker.n8n.io/n8nio/n8n:2.43.4@sha256:c34ee9107a42b837e25cec0c8a927ab90a45b776aa2ccbf15e5b9cda466fad2c';
const name = `cezar-webhooks-check-${randomUUID()}`;
const directory = await mkdtemp(join(tmpdir(), 'cezar-n8n-check-'));
const docs = fileURLToPath(new URL('../docs/', import.meta.url));
let created = false;
const docker = (...args) => exec('docker', args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
try {
  const workflow = JSON.parse(await readFile(join(docs, 'webhook-n8n.json'), 'utf8'));
  workflow.id = 'cezarLifecycleFixture';
  await writeFile(join(directory, 'workflow.json'), JSON.stringify(workflow));
  await writeFile(join(directory, 'check.mjs'), await readFile(new URL('../test/fixtures/webhook-n8n-check.mjs', import.meta.url)));
  await docker('run', '-d', '--name', name, '--network', 'none', '--user', 'root', '--entrypoint', 'sh',
    '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_VERSION_NOTIFICATIONS_ENABLED=false', '-e', 'N8N_TEMPLATES_ENABLED=false',
    '-e', 'N8N_PERSONALIZATION_ENABLED=false', '-e', 'N8N_LISTEN_ADDRESS=127.0.0.1', '-e', 'N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true',
    '-v', `${directory}:/test`, '-v', `${docs}:/recipes:ro`, image, '-c', 'tail -f /dev/null');
  created = true;
  await docker('exec', name, 'n8n', 'import:workflow', '--input=/test/workflow.json');
  await docker('exec', name, 'n8n', 'publish:workflow', '--id=cezarLifecycleFixture');
  await docker('exec', '-d', name, 'sh', '-c', 'n8n start > /test/server.log 2>&1');
  const result = await docker('exec', name, 'node', '/test/check.mjs');
  process.stdout.write(result.stdout);
} catch (error) {
  process.stderr.write(error.stderr ?? error.message); process.exitCode = 1;
} finally {
  if (created) await docker('rm', '-f', name);
  await rm(directory, { recursive: true, force: true });
}
