/**
 * OS-verified process and boot identity for webhook ownership fencing
 * (spec `.ai/specs/2026-10-12-outbound-webhooks.md` §"Single owner and lazy projects").
 *
 * A heartbeat, a bare PID or process age never proves death. Linux reads `/proc`; macOS and
 * Windows ask the OS (`ps`/`sysctl`, PowerShell). Every probe is fail-closed: a probe that
 * cannot run throws, so an unverifiable owner is never declared dead and never double-owned.
 *
 * The returned `start` is an opaque, platform-local token that is stable for the life of one
 * process and different for a later process that reuses its PID.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { webhookPlatformSupported, WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE } from './platform.ts';

// A cold Windows PowerShell + CIM spawn costs ~1s; the bound only has to be long enough that a
// transient timeout never reads as an unverifiable owner (it fails closed either way).
const PROBE_TIMEOUT_MS = 10000;
/** Linux `pid_max` max is 2^22; a larger requested pid cannot be live there. */
const MAX_LINUX_PID = 4_194_304;
/** macOS `ps` refuses any pid at or above 100000 (PID_MAX). */
const MAX_DARWIN_PID = 99_999;
/** Windows pids are full 32-bit values, so applying the Linux ceiling would declare a live owner dead. */
const MAX_WIN32_PID = 0xffff_ffff;
const VERIFY_ERROR = 'Cannot verify process identity';
/** Printed last by the Windows probe so a script that died mid-way is never read as "no such pid". */
const WINDOWS_PROBE_SENTINEL = 'cez-probe-complete';

function probe(command: string, args: string[], partial = false, environment: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(command, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: environment, windowsHide: true });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string; signal?: NodeJS.Signals | null; status?: number | null };
    // `ps` may list the pids it found and exit non-zero when another is gone, so a partial result
    // is only trusted when the child exited NORMALLY. A killed or timed-out probe (signal set,
    // status null) must never pass for "no such pid" — that would declare a live owner dead.
    const normalExit = failure.signal == null && typeof failure.status === 'number';
    if (partial && failure.code !== 'ENOENT' && normalExit && typeof failure.stdout === 'string') return failure.stdout;
    throw new Error(VERIFY_ERROR);
  }
}

function linuxProcessStart(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined;
    if (!fields[19] || !/^\d+$/.test(fields[19])) throw new Error(VERIFY_ERROR);
    return fields[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(VERIFY_ERROR);
  }
}

/** Parses `ps -o pid=,state=,lstart=` output; exported so the macOS parse is pinned without a Mac. */
export function parseDarwinProcessStarts(output: string): Map<number, string> {
  const starts = new Map<number, string>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    // Match the C-locale tail `Www Mmm dd hh:mm:ss yyyy` by shape rather than a fixed 24-column
    // slice: a widened field must fail closed, never silently drop a live owner's row.
    const match = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\d{4})\s*$/.exec(line);
    const rawPid = match?.[1], state = match?.[2], rawStart = match?.[3];
    if (rawPid === undefined || state === undefined || rawStart === undefined) throw new Error(VERIFY_ERROR);
    if (state.startsWith('Z') || state.startsWith('X')) continue;
    // `lstart` under TZ=UTC is UTC wall time without a zone suffix, so pin GMT when parsing.
    const seconds = Math.floor(new Date(`${rawStart.replace(/\s+/g, ' ')} GMT`).getTime() / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(VERIFY_ERROR);
    starts.set(Number(rawPid), String(seconds));
  }
  return starts;
}

function darwinProcessStarts(pids: number[]): Map<number, string> {
  // `LC_ALL`/`TZ` must be pinned on BOTH writer and reader: a locale- or zone-dependent
  // `lstart` string would make a live owner look dead and authorize an unsafe takeover. The
  // binaries are absolute: a GUI/launchd PATH has /usr/bin but sysctl lives in /usr/sbin.
  return parseDarwinProcessStarts(probe('/bin/ps', ['-p', pids.join(','), '-o', 'pid=,state=,lstart='], true, { ...process.env, LC_ALL: 'C', TZ: 'UTC' }));
}

/**
 * Parses the Windows probe output. A pid counts as absent only when the probe ran to the end
 * (sentinel present) and did not report it; a pid that exists but whose start time is unreadable
 * (`unknown`) fails closed — dropping it would declare a live owner dead and authorize takeover.
 */
export function parseWindowsProcessStarts(output: string): Map<number, string> {
  const lines = output.split('\n').map(line => line.trim());
  if (!lines.includes(WINDOWS_PROBE_SENTINEL)) throw new Error(VERIFY_ERROR);
  const starts = new Map<number, string>();
  for (const line of lines) {
    if (!line || line === WINDOWS_PROBE_SENTINEL) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(line);
    const rawPid = match?.[1], ticks = match?.[2];
    if (rawPid === undefined || ticks === undefined) throw new Error(VERIFY_ERROR);
    starts.set(Number(rawPid), ticks);
  }
  return starts;
}

function windowsProcessStarts(pids: number[]): Map<number, string> {
  // `Get-Process -Id` conflates "no such process" with a failed lookup, and only an unreadable
  // `StartTime` fails closed — so one full listing is taken instead, where a pid's absence from the
  // snapshot is the only way to read it as gone. A listing that fails kills the script before the
  // sentinel, which the parser rejects. `StartTime` throws for a process this user cannot open
  // (protected/elevated/other-user), so that case is reported as `unknown`, never as absent.
  return parseWindowsProcessStarts(probe('powershell', ['-NoProfile', '-NonInteractive', '-Command', windowsProbeScript(pids)]));
}

/** Exported so the Windows-only hardening is pinned on a host that cannot run PowerShell. */
export function windowsProbeScript(pids: number[]): string {
  return `$all = @(Get-Process -ErrorAction Stop); foreach ($id in @(${pids.join(',')})) { $p = $all | Where-Object { $_.Id -eq $id } | Select-Object -First 1; if ($null -eq $p) { continue }; try { "$id $($p.StartTime.ToUniversalTime().Ticks)" } catch { "$id unknown" } }; '${WINDOWS_PROBE_SENTINEL}'`;
}

/** Largest pid that can be live on this platform; a larger requested pid is provably absent. */
export function maxProbePid(platform: NodeJS.Platform = process.platform): number {
  if (platform === 'win32') return MAX_WIN32_PID;
  // macOS `ps` rejects any pid >= 100000 with "process id too large" and aborts the WHOLE call,
  // so a pid above its ceiling must be dropped before the probe, never sent to `ps`.
  if (platform === 'darwin') return MAX_DARWIN_PID;
  return MAX_LINUX_PID;
}

/** Start tokens for the requested PIDs. A PID absent from the result is provably not running. */
export function processStarts(pids: number[]): Map<number, string> {
  const ceiling = maxProbePid();
  const candidates = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0 && pid <= ceiling);
  if (!candidates.length) return new Map();
  if (!webhookPlatformSupported()) throw new Error(WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE);
  if (process.platform === 'linux') {
    const starts = new Map<number, string>();
    for (const pid of candidates) { const start = linuxProcessStart(pid); if (start !== undefined) starts.set(pid, start); }
    return starts;
  }
  return process.platform === 'darwin' ? darwinProcessStarts(candidates) : windowsProcessStarts(candidates);
}

let bootCache: string | undefined;
/** Windows-only, exported so the boot-token choice is pinned without a Windows host. */
export const WINDOWS_BOOT_SCRIPT = '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.Ticks';
function bootIdentity(): string {
  if (bootCache !== undefined) return bootCache;
  if (process.platform === 'linux') bootCache = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  else if (process.platform === 'darwin') bootCache = probe('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid']).trim();
  // The boot token must be constant for the whole boot session: `LastBootUpTime.Ticks` is the
  // value WMI recorded, while `.ToUniversalTime()` would re-apply the CURRENT zone offset and
  // could make two processes in one boot session disagree (a live owner read as dead).
  else if (process.platform === 'win32') bootCache = probe('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_BOOT_SCRIPT]).trim();
  else throw new Error(WEBHOOK_UNSUPPORTED_PLATFORM_MESSAGE);
  if (!bootCache) throw new Error(VERIFY_ERROR);
  return bootCache;
}

export interface OwnProcessIdentity { pid: number; start: string; boot: string }
let ownCache: OwnProcessIdentity | undefined;
/**
 * This process's own identity, memoized: it cannot change while the process lives, and
 * re-probing on every ownership check would shell out on the hot path (`valid()`).
 */
export function ownProcessIdentity(): OwnProcessIdentity {
  if (ownCache) return ownCache;
  const start = processStarts([process.pid]).get(process.pid);
  if (start === undefined) throw new Error(VERIFY_ERROR);
  ownCache = { pid: process.pid, start, boot: bootIdentity() };
  return ownCache;
}
