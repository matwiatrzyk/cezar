import { it, expect } from 'vitest';
import { SlackInbound, type SlackServiceDependencies } from './slack-service.ts';
import { ChatInbound } from '../chat/service.ts';
import { realpathSync } from 'node:fs';
import type { ChatServiceDependencies } from '../chat/service.ts';
it('composes the shared inbound service lazily, keeps wire dependencies live and leaves the caller object untouched', async () => {
 let calls = 0, identity = 'U1';
 const deps = {
  root: realpathSync(process.cwd()), directory: '/unused-slack-test', projectId: 'p', installationId: 'i', mode: 'local',
  receivers: () => [], changed() {},
  wire: () => ({ socket() { throw new Error('unexpected socket'); }, async call() { calls++; return { team_id: 'T1', user_id: identity }; } }),
 } as unknown as SlackServiceDependencies;
 const service = new SlackInbound(deps); expect(service).toBeInstanceOf(ChatInbound); expect(calls).toBe(0);
 const adapted = (service as unknown as { deps: ChatServiceDependencies }).deps;
 expect(Object.getOwnPropertyNames(deps)).not.toContain('provider'); // L4: the caller's object is never modified
 expect(adapted.provider.id).toBe('slack');
 expect(await adapted.transport('r').identify()).toEqual({ id: 'T1:U1', username: 'T1:U1' });
 identity = 'U2'; expect(await adapted.transport('r').identify()).toEqual({ id: 'T1:U2', username: 'T1:U2' });
 expect(adapted.credentialTransport).toBeUndefined();
 deps.wireCredential = () => deps.wire('r');
 expect(await adapted.credentialTransport!('opaque').identify()).toEqual({ id: 'T1:U2', username: 'T1:U2' });
});
