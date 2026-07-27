// ---------------------------------------------------------------------------
// bunpilot – PID File Utilities
// ---------------------------------------------------------------------------

import { execSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Write a PID number to the given file path (synchronous to prevent data loss). */
export function writePidFile(pidFile: string, pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    throw new Error('PID must be a positive safe integer');
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile, String(pid), { mode: 0o600 });
  chmodSync(pidFile, 0o600);
}

/** Read the PID from a file. Returns null when the file does not exist. */
export function readPidFile(pidFile: string): number | null {
  try {
    const text = readFileSync(pidFile, 'utf-8').trim();
    if (!/^[1-9]\d*$/.test(text)) return null;
    const pid = Number(text);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Remove the PID file, optionally only when it still contains `expectedPid`. */
export function removePidFile(pidFile: string, expectedPid?: number): boolean {
  if (expectedPid !== undefined && readPidFile(pidFile) !== expectedPid) return false;
  try {
    unlinkSync(pidFile);
    return true;
  } catch {
    // File does not exist – nothing to remove
    return false;
  }
}

/**
 * Check whether a process with the given PID is currently running.
 * Uses `process.kill(pid, 0)` which sends no signal but throws if
 * the process does not exist.
 */
export function isProcessRunning(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify that the process with the given PID is a bunpilot/bun process.
 * Guards against PID reuse where an unrelated process may have taken the PID.
 * On macOS uses `ps -p PID -o command=`, on Linux reads `/proc/{pid}/cmdline`.
 */
export function isBunpilotProcess(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    // First check if the process exists at all
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const cmd = readProcessCommand(pid);
  return cmd !== null && isBunpilotCommand(cmd);
}

/**
 * Best-effort check that the live process at `pid` is a bunpilot worker running
 * `scriptRef`. Workers are spawned as `<runtime> run <script>`, so their command
 * line contains the script path — pass the FULL stored `config.script` (not just
 * its basename) so a PID the OS reused for an unrelated process that merely runs
 * a same-named script is not matched. Used before SIGKILLing a persisted worker
 * PID at boot: orphan reconciliation must be identity-verified.
 */
export function isBunpilotWorkerProcess(pid: number, scriptRef: string): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || scriptRef.length === 0) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const cmd = readProcessCommand(pid);
  return cmd?.replaceAll('\\', '/').includes(scriptRef.replaceAll('\\', '/')) ?? false;
}

/** Read a process's command line: `/proc/<pid>/cmdline` on Linux, else `ps`. */
function readProcessCommand(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replaceAll('\0', ' ');
    }
    return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

function isBunpilotCommand(command: string): boolean {
  // The daemon is always spawned with the hidden `__daemon` sub-command
  // ([execPath, '__daemon'] or [execPath, 'run', entry, '__daemon']), optionally
  // followed by a single config path when started with `--config`. That marker —
  // not the install path — is the stable identity signal, so a renamed or
  // vendored binary is still recognized (h20 / BUG CLASS P).
  //
  // The marker must be the last or second-to-last token (and never argv[0]): a
  // config-started daemon carries the config path after it, while an unrelated
  // PID-reused process with a stray `__daemon` argument buried mid-command line
  // is still rejected rather than signalled.
  const tokens = command.replaceAll('\\', '/').trim().split(/\s+/);
  const marker = tokens.findIndex((t) => t.toLowerCase() === '__daemon');
  return marker >= 1 && marker >= tokens.length - 2;
}

/**
 * Inspect the PID file and determine daemon state.
 *
 * - `'running'` – PID file exists and the process is alive
 * - `'stale'`   – PID file exists but the process is dead
 * - `'none'`    – no PID file on disk
 */
export function checkStalePid(pidFile: string): 'running' | 'stale' | 'none' {
  const pid = readPidFile(pidFile);
  if (pid === null) return 'none';
  return isProcessRunning(pid) ? 'running' : 'stale';
}
