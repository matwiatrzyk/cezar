import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  bootIsStableId, maxProbePid, ownProcessIdentity, parseDarwinProcessStarts, parseWindowsProcessStarts, powershellCommand, processStarts,
} from './process-identity.ts';

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
  }, 70_000);

  it.runIf(process.platform === 'linux')('records the Linux PID namespace and a boot_id that counts as a stable boot ID', () => {
    const own = ownProcessIdentity();
    expect(own.pidNamespace).toBe(readlinkSync('/proc/self/ns/pid'));
    expect(own.pidNamespace).toMatch(/^pid:\[\d+\]$/);
    expect(own.boot).toBe(readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
    expect(bootIsStableId(own.boot)).toBe(true);
  });

  it('treats only random boot IDs as proof of a different boot, never the clock-derived Windows instant', () => {
    expect(bootIsStableId('6F1C2A3B-0D4E-4F50-8A61-7B8C9D0E1F20')).toBe(true);
    expect(bootIsStableId('133600000000000000')).toBe(false);
    expect(bootIsStableId('boot')).toBe(false);
    expect(bootIsStableId('6f1c2a3b-0d4e-4f50-8a61-7b8c9d0e1f20 ')).toBe(false);
  });

  it('treats an out-of-range PID as provably absent rather than probing it', () => {
    // Above macOS's ceiling and above the 32-bit Windows ceiling: dropped before any probe, so
    // this never shells out (and never asks Windows about a pid the platform could hold).
    expect(withPlatform('darwin', () => processStarts([2_147_483_647]).size)).toBe(0);
    expect(withPlatform('win32', () => processStarts([4_294_967_296]).size)).toBe(0);
    expect(processStarts([0, -1, 1.5]).size).toBe(0);
  });

  it('fails closed on a platform without a verified identity instead of reporting death', () => {
    expect(() => withPlatform('freebsd', () => processStarts([process.pid]))).toThrow(/platform/i);
  });

  // macOS `ps` aborts the WHOLE call on any pid >= 100000, so a stale lock pid above the ceiling
  // must be dropped before the probe (provably dead) rather than sent along with live pids.
  it('caps the probe range per platform, not at the Linux pid_max', () => {
    expect(maxProbePid('linux')).toBe(4_194_304);
    expect(maxProbePid('darwin')).toBe(99_999);
    expect(maxProbePid('win32')).toBe(0xffff_ffff);
  });

  // A service or scheduled-task context can have a trimmed PATH, where a bare `powershell` would
  // ENOENT and leave webhooks unavailable on Windows.
  it('resolves PowerShell from SystemRoot, falling back to PATH', () => {
    const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-winroot-'));
    try {
      const exe = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      mkdirSync(join(root, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true }); writeFileSync(exe, '');
      expect(powershellCommand({ SystemRoot: root })).toBe(exe);
      expect(powershellCommand({ windir: root })).toBe(exe);
      expect(powershellCommand({ SystemRoot: '/nonexistent' })).toBe('powershell');
      expect(powershellCommand({})).toBe('powershell');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('parseDarwinProcessStarts', () => {
  const epoch = (y: number, m: number, d: number, h: number, min: number, s: number) => String(Date.UTC(y, m, d, h, min, s) / 1000);

  it('parses the C-locale lstart tail, including the space-padded single-digit day', () => {
    expect(parseDarwinProcessStarts('    1 Ss   Thu Oct  8 09:26:18 2026\n'))
      .toEqual(new Map([[1, epoch(2026, 9, 8, 9, 26, 18)]]));
  });

  it('drops zombies and dead states, because they hold no live owner', () => {
    expect(parseDarwinProcessStarts('22899 ZN   Sat Oct 17 05:05:10 2026\n').size).toBe(0);
    expect(parseDarwinProcessStarts('22899 X    Sat Oct 17 05:05:10 2026\n').size).toBe(0);
  });

  it('treats empty output as "no such pid" only when it is empty', () => {
    expect(parseDarwinProcessStarts('').size).toBe(0);
    expect(parseDarwinProcessStarts('\n').size).toBe(0);
  });

  it('fails closed on a line it cannot read, rather than dropping a live owner', () => {
    expect(() => parseDarwinProcessStarts('ps: process id too large: 999999\n')).toThrow(/process identity/i);
    // A locale that widened the date (here pl_PL) must throw, never silently skip the pid.
    expect(() => parseDarwinProcessStarts('1 Ss   czw.  8 paź 09:26:18 2026\n')).toThrow(/process identity/i);
  });
});

describe('parseWindowsProcessStarts', () => {
  it('parses ticks as strings, tolerating a BOM and CRLF', () => {
    expect(parseWindowsProcessStarts('\uFEFF4242 638912345678901234\r\ncez-probe-complete\r\n'))
      .toEqual(new Map([[4242, '638912345678901234']]));
  });

  it('reads a missing pid as absent only when the probe ran to its sentinel', () => {
    expect(parseWindowsProcessStarts('cez-probe-complete\n').size).toBe(0);
  });

  it('fails closed when the script died before its sentinel', () => {
    expect(() => parseWindowsProcessStarts('4242 638912345678901234\n')).toThrow(/process identity/i);
  });

  it('fails closed when a pid exists but its start time was unreadable', () => {
    expect(() => parseWindowsProcessStarts('4242 unknown\ncez-probe-complete\n')).toThrow(/process identity/i);
  });

  it('fails closed on unrecognised output, never reading it as absence', () => {
    expect(() => parseWindowsProcessStarts('Get-Process : Cannot find a process\ncez-probe-complete\n')).toThrow(/process identity/i);
  });
});
