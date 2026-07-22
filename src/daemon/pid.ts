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

  try {
    if (process.platform === 'linux') {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return isBunpilotCommand(cmdline.replaceAll('\0', ' '));
    }

    // macOS / other Unix: use ps
    const cmd = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8' }).trim();
    return isBunpilotCommand(cmd);
  } catch {
    return false;
  }
}

function isBunpilotCommand(command: string): boolean {
  const normalized = command.replaceAll('\\', '/').toLowerCase();
  if (!/(?:^|\s)__daemon(?:\s|$)/.test(normalized)) return false;
  return (
    normalized.includes('bunpilot') ||
    normalized.includes('/src/daemon/boot.') ||
    normalized.includes('/src/index.')
  );
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
