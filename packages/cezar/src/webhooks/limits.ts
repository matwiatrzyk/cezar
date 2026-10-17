import { z } from 'zod';
import { atomicWrite, readState } from './storage.ts';
const stateSchema = z.strictObject({
  version: z.literal(1), tokens: z.number().min(0).max(10), at: z.number().nonnegative(),
  tests: z.record(z.string().max(255), z.array(z.number().nonnegative()).max(3)),
  failures: z.array(z.number().nonnegative()).max(10),
});
type LimitState = z.infer<typeof stateSchema>;
export class ProjectLimits {
  private constructor(private readonly directory: string, private state: LimitState) {}
  static async open(directory: string): Promise<ProjectLimits> {
    const state = await readState(directory, 'limits.json', stateSchema) ?? { version: 1 as const, tokens: 10, at: 0, tests: {}, failures: [] };
    return new ProjectLimits(directory, state);
  }
  /** Called under the owning project's mutation queue immediately before claim. */
  async take(request: { host: string; test?: boolean; manualFailure?: boolean; preview?: boolean }, now: number): Promise<{ allowed: true } | { allowed: false; retryAt: number }> {
    if (request.host.length > 255) throw new Error('Invalid destination host');
    // Materialize elapsed refill and window ages at every observation, including
    // denials/previews. A rollback shifts the time origin, never grants tokens.
    // Persist before returning so a restart cannot resurrect the old clock.
    const delta = Math.min(0, now - this.state.at);
    const tokens = Math.min(10, this.state.tokens + Math.max(0, now - this.state.at) / 500);
    // Clamp only live entries at the epoch boundary (conservatively <= 60s);
    // expired entries must not be resurrected by that clamp.
    const rebase = (times: number[]) => times.filter(time => time > Math.max(now, this.state.at) - 60000).map(time => Math.max(0, time + delta));
    const failures = rebase(this.state.failures);
    const tests = Object.fromEntries(Object.entries(this.state.tests).map(([host, times]) => [host, rebase(times)] as const).filter(([, times]) => times.length));
    const observed = stateSchema.parse({ version: 1, tokens, at: now, tests, failures });
    const hostTests = Object.hasOwn(tests, request.host) ? tests[request.host]! : [];
    let retryAt = now;
    if (tokens < 1) retryAt = Math.max(retryAt, now + Math.ceil((1 - tokens) * 500));
    if (request.test && hostTests.length >= 3) retryAt = Math.max(retryAt, hostTests[0]! + 60000);
    if (request.manualFailure && failures.length >= 10) retryAt = Math.max(retryAt, failures[0]! + 60000);
    if (retryAt > now || request.preview) {
      if (JSON.stringify(observed) !== JSON.stringify(this.state)) {
        await atomicWrite(this.directory, 'limits.json', observed); this.state = observed;
      }
      return retryAt > now ? { allowed: false, retryAt } : { allowed: true };
    }
    if (request.test) Object.defineProperty(tests, request.host, {
      value: [...hostTests, now], enumerable: true, configurable: true, writable: true,
    });
    if (request.manualFailure) failures.push(now);
    const next = stateSchema.parse({ version: 1, tokens: tokens - 1, at: now, tests, failures });
    await atomicWrite(this.directory, 'limits.json', next); this.state = next;
    return { allowed: true };
  }
}
