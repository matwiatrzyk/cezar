import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { ownProcessIdentity, processStarts, WINDOWS_BOOT_SCRIPT } from './process-identity.ts';

// The probe is the one shell-based path whose failure mode decides whether a LIVE owner is
// declared dead (unsafe takeover), so mock the child process and pin the fail-closed direction.
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const probe = vi.mocked(execFileSync);

function withPlatform<T>(platform: string, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try { return run(); } finally { Object.defineProperty(process, 'platform', original); }
}

const PS_LINE = '   4242 Ss   Thu Oct  8 09:26:18 2026\n';

function failWith(over: Record<string, unknown>): void {
  probe.mockImplementationOnce(() => { throw Object.assign(new Error('probe failed'), over); });
}

describe('probe fail-closed behaviour', () => {
  it('never reads a killed or timed-out probe as "no such pid"', () => {
    // execFileSync reports a timeout as ETIMEDOUT/SIGTERM with an empty stdout.
    failWith({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: '' });
    expect(() => withPlatform('darwin', () => processStarts([4242]))).toThrow(/process identity/i);
  });

  it('discards even a partial listing from a killed probe, because a live pid may be missing', () => {
    failWith({ code: 'ETIMEDOUT', signal: 'SIGTERM', status: null, stdout: '   4243 Ss   Thu Oct  8 09:26:18 2026\n' });
    expect(() => withPlatform('darwin', () => processStarts([4242]))).toThrow(/process identity/i);
  });

  it('still trusts a partial listing from a probe that exited normally', () => {
    failWith({ code: 'ESRCH', signal: null, status: 1, stdout: PS_LINE });
    expect(withPlatform('darwin', () => processStarts([4242])).get(4242)).toBe(String(Date.UTC(2026, 9, 8, 9, 26, 18) / 1000));
  });

  it('fails closed when the probed binary is missing', () => {
    failWith({ code: 'ENOENT', signal: null, status: null, stdout: '' });
    expect(() => withPlatform('darwin', () => processStarts([4242]))).toThrow(/process identity/i);
  });

  it('drops a pid above the platform ceiling before shelling out', () => {
    probe.mockClear();
    expect(withPlatform('darwin', () => processStarts([100_000]))).toEqual(new Map());
    expect(probe).not.toHaveBeenCalled();
  });

  it('spawns the macOS probe by absolute path with a pinned locale and zone', () => {
    // A GUI/launchd PATH has /usr/bin but not /usr/sbin, and an unpinned locale or zone changes
    // `lstart` in a way that reads a live owner as dead.
    probe.mockClear();
    probe.mockImplementationOnce(() => PS_LINE);
    withPlatform('darwin', () => processStarts([4242]));
    expect(probe).toHaveBeenCalledWith('/bin/ps', ['-p', '4242', '-o', 'pid=,state=,lstart='], expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C', TZ: 'UTC' }), windowsHide: true }));
  });

  it.each([
    ['missing sentinel', `${process.pid} 638000000000000000 638900000000000000\n`],
    ['extra output', `${process.pid} 638000000000000000 638900000000000000\nnoise\ncez-own-probe-complete\n`],
    ['malformed ticks', `${process.pid} unknown 638900000000000000\ncez-own-probe-complete\n`],
    ['different pid', `${process.pid + 1} 638000000000000000 638900000000000000\ncez-own-probe-complete\n`],
  ])('fails closed when the combined Windows probe has %s', (_name, output) => {
    probe.mockImplementationOnce(() => output);
    expect(() => withPlatform('win32', () => ownProcessIdentity())).toThrow(/process identity/i);
  });

  it('asks Windows for UTC ticks in one probe, and records no PID namespace there', () => {
    // Pins the script only: this mock cannot prove clock or zone independence.
    // A boot-token mismatch alone cannot authorize takeover (ownership-liveness.test.ts).
    probe.mockClear();
    probe.mockImplementationOnce((_command, args) => {
      const script = String(args?.[3]);
      expect(script).toContain('Get-Process -ErrorAction Stop');
      expect(script).toContain('LastBootUpTime.ToUniversalTime().Ticks');
      return `${process.pid} 638000000000000000 638900000000000000\ncez-own-probe-complete\n`;
    });
    const own = withPlatform('win32', () => ownProcessIdentity());
    expect(own.boot).toBe('638900000000000000');
    expect(own.start).toBe('638000000000000000');
    expect(own.pidNamespace).toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(1);
    // One full listing, never a per-pid lookup whose failure would read as "no such process".
    const probeScript = String(probe.mock.calls[0]?.[1]?.[3]);
    expect(probeScript).toContain('Get-Process -ErrorAction Stop');
    expect(probeScript).not.toContain('SilentlyContinue');
    expect(probeScript).toContain('cez-own-probe-complete');
    expect(WINDOWS_BOOT_SCRIPT).toBe('(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks');
  });
});
