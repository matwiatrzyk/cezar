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

const PROBE_TIMEOUT_MS = 5000;
/** Above every supported platform's PID ceiling (Linux `pid_max` default 2^22); treated as dead. */
const MAX_PID = 4_194_304;
const VERIFY_ERROR = 'Cannot verify process identity';

function probe(command: string, args: string[], partial = false, environment: NodeJS.ProcessEnv = process.env): string {
  try {
    return execFileSync(command, args, { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: environment });
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stdout?: string };
    // `ps` lists the pids it found and exits non-zero when another is gone; a missing binary
    // (ENOENT) is a broken probe and must fail closed rather than report the owner dead.
    if (partial && failure.code !== 'ENOENT' && typeof failure.stdout === 'string') return failure.stdout;
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

function darwinProcessStarts(pids: number[]): Map<number, string> {
  const starts = new Map<number, string>();
  // `LC_ALL`/`TZ` must be pinned on BOTH writer and reader: a locale- or zone-dependent
  // `lstart` string would make a live owner look dead and authorize an unsafe takeover.
  const output = probe('ps', ['-p', pids.join(','), '-o', 'pid=,state=,lstart='], true, { ...process.env, LC_ALL: 'C', TZ: 'UTC' });
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.{24})\s*$/.exec(line);
    const rawPid = match?.[1], state = match?.[2], rawStart = match?.[3];
    if (rawPid === undefined || state === undefined || rawStart === undefined) continue;
    if (state.startsWith('Z') || state.startsWith('X')) continue;
    // `lstart` under TZ=UTC is UTC wall time without a zone suffix, so pin GMT when parsing.
    const seconds = Math.floor(new Date(`${rawStart.trim()} GMT`).getTime() / 1000);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(VERIFY_ERROR);
    starts.set(Number(rawPid), String(seconds));
  }
  return starts;
}

function windowsProcessStarts(pids: number[]): Map<number, string> {
  const script = `foreach ($id in @(${pids.join(',')})) { try { $p = Get-Process -Id $id -ErrorAction Stop; "$id $($p.StartTime.ToUniversalTime().Ticks)" } catch {} }`;
  const output = probe('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const starts = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    const rawPid = match?.[1], ticks = match?.[2];
    if (rawPid === undefined || ticks === undefined) continue;
    starts.set(Number(rawPid), ticks);
  }
  return starts;
}

/** Start tokens for the requested PIDs. A PID absent from the result is provably not running. */
export function processStarts(pids: number[]): Map<number, string> {
  const candidates = [...new Set(pids)].filter(pid => Number.isInteger(pid) && pid > 0 && pid <= MAX_PID);
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
function bootIdentity(): string {
  if (bootCache !== undefined) return bootCache;
  if (process.platform === 'linux') bootCache = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  else if (process.platform === 'darwin') bootCache = probe('sysctl', ['-n', 'kern.bootsessionuuid']).trim();
  else if (process.platform === 'win32') bootCache = probe('powershell', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().Ticks']).trim();
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
