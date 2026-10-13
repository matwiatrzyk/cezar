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
    const tokens = Math.min(10, this.state.tokens + Math.max(0, now - this.state.at) / 500);
    const failures = this.state.failures.filter(time => time > now - 60000);
    const tests = Object.fromEntries(Object.entries(this.state.tests).map(([host, times]) => [host, times.filter(time => time > now - 60000)] as const).filter(([, times]) => times.length));
    const hostTests = tests[request.host] ?? [];
    let retryAt = now;
    if (tokens < 1) retryAt = Math.max(retryAt, Math.max(now, this.state.at) + Math.ceil((1 - tokens) * 500));
    if (request.test && hostTests.length >= 3) retryAt = Math.max(retryAt, hostTests[0]! + 60000);
    if (request.manualFailure && failures.length >= 10) retryAt = Math.max(retryAt, failures[0]! + 60000);
    if (retryAt > now) return { allowed: false, retryAt };
    if (request.preview) return { allowed: true };
    if (request.test) tests[request.host] = [...hostTests, now];
    if (request.manualFailure) failures.push(now);
    const next = stateSchema.parse({ version: 1, tokens: tokens - 1, at: Math.max(now, this.state.at), tests, failures });
    await atomicWrite(this.directory, 'limits.json', next); this.state = next;
    return { allowed: true };
  }
}
