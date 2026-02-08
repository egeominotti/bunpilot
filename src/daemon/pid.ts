// ---------------------------------------------------------------------------
// bunpilot – PID File Utilities
// ---------------------------------------------------------------------------

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Write a PID number to the given file path (synchronous to prevent data loss). */
export function writePidFile(pidFile: string, pid: number): void {
  writeFileSync(pidFile, String(pid));
}

/** Read the PID from a file. Returns null when the file does not exist. */
export function readPidFile(pidFile: string): number | null {
  try {
    const text = readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(text, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** Remove the PID file from disk. Silently ignores missing files. */
export function removePidFile(pidFile: string): void {
  try {
    unlinkSync(pidFile);
  } catch {
    // File does not exist – nothing to remove
  }
}

/**
 * Check whether a process with the given PID is currently running.
 * Uses `process.kill(pid, 0)` which sends no signal but throws if
 * the process does not exist.
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
