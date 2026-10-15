import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const exec = promisify(execFile);
const credential = 'syntheticSecretABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Real undici 6 response parser/stream, isolated so disposal errors fail the
// process. Only the socket is routed locally: no public network traffic.
const client = `
  import { createRequire } from 'node:module';
  const require = createRequire(import.meta.url);
  const net = require('node:net'), connect = net.connect;
  net.connect = function(options, ...rest) {
    return connect.call(this, { ...options, host: '127.0.0.1', port: Number(process.argv[2]), lookup: undefined }, ...rest);
  };
  process.env.TEST_DIAGNOSTIC_SECRET = process.argv[3];
  const { sendWebhook } = await import(process.argv[1]);
  const result = await sendWebhook({
    url: 'http://public.example:' + process.argv[2] + '/', body: '{}', eventId: 'evt_test',
    secrets: ['whsec_' + Buffer.alloc(32, 7).toString('base64')],
    policy: { mode: 'local', allowLocalNetwork: false, serverPorts: [] },
  }, { lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  console.log(JSON.stringify(result));
`;

it.each(['crossing', 'exact', 'stream', 'partial', 'complete', 'split', 'below', 'empty'] as const)(
  'retains only complete below-limit public diagnostics (%s)', async mode => {
    const server = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '60' });
        if (mode === 'split') {
          response.write('safe ' + credential.slice(0, 20));
          setTimeout(() => response.end(credential.slice(20)), 20);
        } else if (mode === 'below') response.end('x'.repeat(4095));
        else if (mode === 'crossing') response.end('x'.repeat(4070) + credential);
        else if (mode === 'exact') response.end('x'.repeat(4096));
        else if (mode === 'stream') response.write('x'.repeat(4096)); // Must cancel, never drain.
        else if (mode === 'partial') {
          response.write('prefix ' + credential.slice(0, 20));
          setTimeout(() => response.destroy(), 20);
        } else response.end(mode === 'empty' ? '' : 'safe ' + credential);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const { stdout, stderr } = await exec(process.execPath, [
        '--import', 'tsx', '--input-type=module', '--eval', client,
        new URL('./transport.ts', import.meta.url).href, String(port), credential,
      ], { timeout: 5000 });
      expect(stderr).toBe('');
      expect(JSON.parse(stdout)).toEqual({
        kind: 'http', status: 429, contentType: 'text/plain', retryAfter: '60',
        ...(mode === 'complete' || mode === 'split' ? { response: 'safe [REDACTED]' } : mode === 'below' ? { response: 'x'.repeat(4095) } : mode === 'empty' ? { response: '' } : {}),
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 10000,
);
