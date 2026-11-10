import { expect, it } from 'vitest';
import { trustedChatWorker } from './trusted-chat-worker.ts';
it('rejects unverified in-process code before activation or host stdio changes', () => {
  const write = process.stdout.write, log = console.log;
  expect(() => trustedChatWorker({ provider:'telegram', extensionId:'open-mercato.telegram', entry:'/tmp/arbitrary.mjs' } as never,
    {onFrame() {throw Error('must not run')}, onExit() {throw Error('must not run')}})).toThrow('verified shipped artifact');
  expect(process.stdout.write).toBe(write); expect(console.log).toBe(log);
});
