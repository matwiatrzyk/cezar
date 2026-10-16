import { describe, expect, it } from 'vitest';
import { ownProcessIdentity, processStarts } from './process-identity.ts';

function withPlatform<T>(platform: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try { return run(); } finally { Object.defineProperty(process, 'platform', original); }
}

describe('OS-verified process identity', () => {
  it('returns a stable, digit-only start token and a non-empty boot identity for this process', () => {
    const own = ownProcessIdentity();
    expect(own.pid).toBe(process.pid);
    expect(own.start).toMatch(/^\d+$/);
    expect(own.boot.length).toBeGreaterThan(0);
    // Memoized and consistent with a fresh lookup of the same PID.
    expect(processStarts([process.pid]).get(process.pid)).toBe(own.start);
    expect(ownProcessIdentity()).toBe(own);
  });

  it('treats an out-of-range PID as provably absent rather than probing it', () => {
    expect(processStarts([2_147_483_647]).size).toBe(0);
    expect(processStarts([0, -1, 1.5]).size).toBe(0);
  });

  it('fails closed on a platform without a verified identity instead of reporting death', () => {
    expect(() => withPlatform('freebsd', () => processStarts([process.pid]))).toThrow(/platform/i);
  });
});
