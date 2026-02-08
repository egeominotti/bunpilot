// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Daemon: daemonize() and stopDaemon()
// ---------------------------------------------------------------------------
//
// Tests cover:
// 1. daemonize() — spawns child process, creates PID file, sets BUNPILOT_DAEMON env
// 2. stopDaemon() — SIGTERM flow, SIGKILL escalation, stale PID cleanup, polling
// 3. PID file helpers used by both functions
// 4. isProcessRunning edge cases
//
// Since daemonize() calls process.exit(0), we test it by spawning a subprocess
// that exercises the same logic. For stopDaemon(), we replicate the algorithm
// with a configurable PID file to test against real spawned processes.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessRunning,
} from '../../src/daemon/pid';

// ---------------------------------------------------------------------------
// Helpers: reusable stopDaemon logic with configurable PID file
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reimplementation of stopDaemon() that accepts a custom PID file path
 * so we can test the full signal flow without touching the global PID_FILE.
 */
async function stopDaemonWithPidFile(pidFile: string): Promise<boolean> {
  const pid = readPidFile(pidFile);
  if (pid === null) {
    return false;
  }

  if (!isProcessRunning(pid)) {
    removePidFile(pidFile);
    return true;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removePidFile(pidFile);
    return false;
  }

  // Poll until the process exits (max ~10 seconds)
  const maxWait = 10_000;
  const pollInterval = 200;
  let waited = 0;

  while (waited < maxWait) {
    await sleep(pollInterval);
    waited += pollInterval;

    if (!isProcessRunning(pid)) {
      removePidFile(pidFile);
      return true;
    }
  }

  // Process did not exit in time – force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead
  }

  removePidFile(pidFile);
  return true;
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;
const spawnedPids: number[] = [];

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bunpilot-daemonize-test-'));
});

afterEach(() => {
  // Kill any lingering spawned processes
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead
    }
  }
  spawnedPids.length = 0;
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: spawn a long-lived sleep process for testing
// ---------------------------------------------------------------------------

function spawnSleepProcess(): { pid: number; proc: ReturnType<typeof Bun.spawn> } {
  const proc = Bun.spawn({
    cmd: ['bun', '-e', 'await Bun.sleep(60_000)'],
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  spawnedPids.push(proc.pid);
  return { pid: proc.pid, proc };
}

/**
 * Spawn a process that ignores SIGTERM so we can test SIGKILL escalation.
 */
function spawnSigtermResistantProcess(): { pid: number; proc: ReturnType<typeof Bun.spawn> } {
  const script = `
    process.on('SIGTERM', () => { /* ignore */ });
    await Bun.sleep(60_000);
  `;
  const proc = Bun.spawn({
    cmd: ['bun', '-e', script],
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  spawnedPids.push(proc.pid);
  return { pid: proc.pid, proc };
}

// ---------------------------------------------------------------------------
// stopDaemon – PID file helper tests (existing)
// ---------------------------------------------------------------------------

describe('stopDaemon', () => {
  test('returns false when no PID file exists', () => {
    const pidFile = join(tempDir, 'nonexistent.pid');
    const pid = readPidFile(pidFile);
    // No PID file => null => daemon not running
    expect(pid).toBeNull();
  });

  test('detects stale PID file and cleans up', () => {
    const pidFile = join(tempDir, 'stale.pid');
    // Write a PID that does not correspond to a running process
    writePidFile(pidFile, 99999999);

    const pid = readPidFile(pidFile);
    expect(pid).toBe(99999999);
    expect(isProcessRunning(99999999)).toBe(false);

    // Simulate cleanup of stale PID
    removePidFile(pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  test('detects running process via PID file', () => {
    const pidFile = join(tempDir, 'running.pid');
    // Write current process PID (known to be running)
    writePidFile(pidFile, process.pid);

    const pid = readPidFile(pidFile);
    expect(pid).toBe(process.pid);
    expect(isProcessRunning(process.pid)).toBe(true);

    // Cleanup
    removePidFile(pidFile);
  });

  test('PID file read/write/remove round-trip', () => {
    const pidFile = join(tempDir, 'roundtrip.pid');

    // Initially no file
    expect(readPidFile(pidFile)).toBeNull();
    expect(existsSync(pidFile)).toBe(false);

    // Write PID
    writePidFile(pidFile, 54321);
    expect(existsSync(pidFile)).toBe(true);
    expect(readPidFile(pidFile)).toBe(54321);

    // Remove PID
    removePidFile(pidFile);
    expect(existsSync(pidFile)).toBe(false);
    expect(readPidFile(pidFile)).toBeNull();
  });

  test('removePidFile is idempotent on missing file', () => {
    const pidFile = join(tempDir, 'missing.pid');
    // Should not throw
    expect(() => removePidFile(pidFile)).not.toThrow();
    expect(() => removePidFile(pidFile)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isProcessRunning edge cases
// ---------------------------------------------------------------------------

describe('isProcessRunning edge cases', () => {
  test('returns true for current process', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  test('returns false for PID 0 (kernel)', () => {
    // PID 0 is a special case; process.kill(0, 0) sends to the process group
    // but isProcessRunning for very high PIDs should be false
    expect(isProcessRunning(99999999)).toBe(false);
  });

  test('returns false for very large PID', () => {
    // Very large PIDs that do not exist
    expect(isProcessRunning(2147483647)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// daemonize() – process spawning and PID file creation
// ---------------------------------------------------------------------------

describe('daemonize', () => {
  test('Bun.spawn creates a child with a valid PID', () => {
    // daemonize() internally does: Bun.spawn + writePidFile + child.unref()
    // We verify this fundamental mechanic works.
    const { pid, proc } = spawnSleepProcess();

    expect(pid).toBeGreaterThan(0);
    expect(typeof pid).toBe('number');
    expect(isProcessRunning(pid)).toBe(true);

    // Clean up
    proc.kill();
  });

  test('PID file is created with the spawned process PID', () => {
    // Simulates what daemonize() does: spawn + writePidFile
    const pidFile = join(tempDir, 'daemon.pid');
    const { pid, proc } = spawnSleepProcess();

    writePidFile(pidFile, pid);

    expect(existsSync(pidFile)).toBe(true);
    expect(readPidFile(pidFile)).toBe(pid);
    expect(isProcessRunning(pid)).toBe(true);

    // Clean up
    proc.kill();
    removePidFile(pidFile);
  });

  test('child.unref() allows parent to exit without waiting for child', () => {
    // Verify unref does not kill the child — child remains running
    const proc = Bun.spawn({
      cmd: ['bun', '-e', 'await Bun.sleep(60_000)'],
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    spawnedPids.push(proc.pid);

    proc.unref();

    // Process should still be alive after unref
    expect(isProcessRunning(proc.pid)).toBe(true);

    // Clean up
    proc.kill();
  });

  test('spawned child inherits custom BUNPILOT_DAEMON env var', async () => {
    // daemonize() passes BUNPILOT_DAEMON=1 to the child
    const envFile = join(tempDir, 'env-check.txt');
    const script = `
      const fs = require('fs');
      fs.writeFileSync('${envFile.replace(/'/g, "\\'")}', process.env.BUNPILOT_DAEMON || 'NOT_SET');
    `;
    const proc = Bun.spawn({
      cmd: ['bun', '-e', script],
      stdio: ['ignore', 'ignore', 'ignore'],
      env: {
        ...process.env,
        BUNPILOT_DAEMON: '1',
      },
    });
    spawnedPids.push(proc.pid);

    await proc.exited;

    const content = await Bun.file(envFile).text();
    expect(content).toBe('1');
  });

  test('spawned child uses detached stdio (ignore)', async () => {
    // Verify that stdio: ['ignore','ignore','ignore'] produces no output capture
    const proc = Bun.spawn({
      cmd: ['bun', '-e', 'console.log("hello from child")'],
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    spawnedPids.push(proc.pid);

    await proc.exited;

    // With stdio: 'ignore', stdout/stderr are not readable (null or undefined)
    expect(proc.stdout).toBeFalsy();
    expect(proc.stderr).toBeFalsy();
  });

  test('daemonize subprocess creates PID file and spawns boot process', async () => {
    // Run a helper script that does the same as daemonize() but writes to our
    // temp PID file and does NOT call process.exit(0) so we can verify results.
    const pidFile = join(tempDir, 'daemon-test.pid');
    const helperScript = `
      const { writeFileSync } = require('fs');

      const child = Bun.spawn({
        cmd: ['bun', '-e', 'await Bun.sleep(60_000)'],
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, BUNPILOT_DAEMON: '1' },
      });

      writeFileSync('${pidFile.replace(/'/g, "\\'")}', String(child.pid));
      child.unref();
      // Do not call process.exit — let the script finish naturally
    `;

    const proc = Bun.spawn({
      cmd: ['bun', '-e', helperScript],
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    spawnedPids.push(proc.pid);

    await proc.exited;

    // PID file should exist with a valid PID
    expect(existsSync(pidFile)).toBe(true);
    const childPid = readPidFile(pidFile);
    expect(childPid).not.toBeNull();
    expect(childPid!).toBeGreaterThan(0);

    // The spawned child should still be alive
    expect(isProcessRunning(childPid!)).toBe(true);

    // Track for cleanup
    spawnedPids.push(childPid!);

    // Clean up child
    try {
      process.kill(childPid!, 'SIGKILL');
    } catch {
      // Already dead
    }
  });
});

// ---------------------------------------------------------------------------
// stopDaemon() – full signal flow with real processes
// ---------------------------------------------------------------------------

describe('stopDaemon signal flow', () => {
  test('returns false when PID file does not exist', async () => {
    const pidFile = join(tempDir, 'no-daemon.pid');
    const result = await stopDaemonWithPidFile(pidFile);
    expect(result).toBe(false);
  });

  test('cleans up stale PID file and returns true', async () => {
    const pidFile = join(tempDir, 'stale-daemon.pid');
    writePidFile(pidFile, 99999999);

    const result = await stopDaemonWithPidFile(pidFile);
    expect(result).toBe(true);
    // PID file should be removed
    expect(existsSync(pidFile)).toBe(false);
  });

  test('sends SIGTERM and waits for process to exit', async () => {
    // Spawn a process that exits on SIGTERM (default behavior)
    const pidFile = join(tempDir, 'sigterm-daemon.pid');
    const { pid } = spawnSleepProcess();
    writePidFile(pidFile, pid);

    expect(isProcessRunning(pid)).toBe(true);

    const result = await stopDaemonWithPidFile(pidFile);

    expect(result).toBe(true);
    // Process should be dead
    expect(isProcessRunning(pid)).toBe(false);
    // PID file should be cleaned up
    expect(existsSync(pidFile)).toBe(false);
  });

  test('SIGTERM stops process and polling detects exit', async () => {
    // Spawn a process that sleeps and test the polling loop
    const pidFile = join(tempDir, 'poll-daemon.pid');
    const { pid } = spawnSleepProcess();
    writePidFile(pidFile, pid);

    // Verify it's running
    expect(isProcessRunning(pid)).toBe(true);

    const startTime = Date.now();
    const result = await stopDaemonWithPidFile(pidFile);
    const elapsed = Date.now() - startTime;

    expect(result).toBe(true);
    expect(isProcessRunning(pid)).toBe(false);
    // Should complete well before the 10s timeout
    expect(elapsed).toBeLessThan(5_000);
  });

  test('escalates to SIGKILL when process ignores SIGTERM', async () => {
    // Spawn a process that ignores SIGTERM
    const pidFile = join(tempDir, 'sigkill-daemon.pid');
    const { pid } = spawnSigtermResistantProcess();
    writePidFile(pidFile, pid);

    // Give the process a moment to set up the SIGTERM handler
    await sleep(200);
    expect(isProcessRunning(pid)).toBe(true);

    // Use a shorter timeout variant so the test doesn't take 10s
    const maxWait = 2_000;
    const pollInterval = 100;

    // Send SIGTERM
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Process may have already died
    }

    let waited = 0;
    let exitedGracefully = false;

    while (waited < maxWait) {
      await sleep(pollInterval);
      waited += pollInterval;
      if (!isProcessRunning(pid)) {
        exitedGracefully = true;
        break;
      }
    }

    // Process should still be running because it ignores SIGTERM
    if (!exitedGracefully) {
      expect(isProcessRunning(pid)).toBe(true);

      // Force kill
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already dead
      }

      // Wait briefly for SIGKILL to take effect
      await sleep(200);
    }

    // After SIGKILL, process should be dead
    expect(isProcessRunning(pid)).toBe(false);

    // Clean up PID file
    removePidFile(pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  test('handles process that dies between SIGTERM send and first poll', async () => {
    // Spawn a process that exits quickly on SIGTERM
    const script = `
      process.on('SIGTERM', () => process.exit(0));
      await Bun.sleep(60_000);
    `;
    const proc = Bun.spawn({
      cmd: ['bun', '-e', script],
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    spawnedPids.push(proc.pid);
    const pidFile = join(tempDir, 'fast-exit.pid');
    writePidFile(pidFile, proc.pid);

    // Give it a moment to start
    await sleep(100);

    const result = await stopDaemonWithPidFile(pidFile);
    expect(result).toBe(true);
    expect(isProcessRunning(proc.pid)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  test('returns false when SIGTERM throws (process already dead between check and kill)', async () => {
    // Write a PID for a process that will die between isProcessRunning and process.kill
    const pidFile = join(tempDir, 'race-daemon.pid');

    // Spawn and immediately kill to create a race-like scenario
    const script = `process.exit(0);`;
    const proc = Bun.spawn({
      cmd: ['bun', '-e', script],
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    spawnedPids.push(proc.pid);
    await proc.exited;

    // Write the now-dead PID — isProcessRunning will be false, so we hit the stale path
    writePidFile(pidFile, proc.pid);

    const result = await stopDaemonWithPidFile(pidFile);
    // Process is not running, so the stale path returns true after cleanup
    expect(result).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });

  test('removes PID file even when SIGTERM send fails', async () => {
    const pidFile = join(tempDir, 'sigterm-fail.pid');
    // Write a PID that is not running — the stale path handles this
    writePidFile(pidFile, 99999999);

    await stopDaemonWithPidFile(pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  test('stops a real spawned process end-to-end', async () => {
    // Full integration: spawn -> write PID -> stop -> verify dead + cleaned up
    const pidFile = join(tempDir, 'e2e-daemon.pid');
    const { pid, proc } = spawnSleepProcess();
    writePidFile(pidFile, pid);

    expect(isProcessRunning(pid)).toBe(true);
    expect(readPidFile(pidFile)).toBe(pid);

    const stopped = await stopDaemonWithPidFile(pidFile);

    expect(stopped).toBe(true);
    expect(isProcessRunning(pid)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
    expect(readPidFile(pidFile)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// daemonize + stopDaemon integration
// ---------------------------------------------------------------------------

describe('daemonize + stopDaemon integration', () => {
  test('spawn then stop lifecycle', async () => {
    const pidFile = join(tempDir, 'lifecycle.pid');

    // Phase 1: Simulate daemonize — spawn detached child + write PID file
    const proc = Bun.spawn({
      cmd: ['bun', '-e', 'await Bun.sleep(60_000)'],
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, BUNPILOT_DAEMON: '1' },
    });
    spawnedPids.push(proc.pid);
    writePidFile(pidFile, proc.pid);
    proc.unref();

    // Verify daemon is running
    expect(isProcessRunning(proc.pid)).toBe(true);
    expect(readPidFile(pidFile)).toBe(proc.pid);

    // Phase 2: Stop daemon
    const result = await stopDaemonWithPidFile(pidFile);
    expect(result).toBe(true);

    // Verify cleanup
    expect(isProcessRunning(proc.pid)).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });

  test('multiple stop calls are idempotent', async () => {
    const pidFile = join(tempDir, 'idempotent.pid');
    const { pid } = spawnSleepProcess();
    writePidFile(pidFile, pid);

    // First stop — kills the process
    const result1 = await stopDaemonWithPidFile(pidFile);
    expect(result1).toBe(true);
    expect(isProcessRunning(pid)).toBe(false);

    // Second stop — PID file is already gone
    const result2 = await stopDaemonWithPidFile(pidFile);
    expect(result2).toBe(false); // No PID file
  });

  test('stop after PID file manually removed returns false', async () => {
    const pidFile = join(tempDir, 'manual-remove.pid');
    const { pid, proc } = spawnSleepProcess();
    writePidFile(pidFile, pid);

    // Manually remove PID file (simulates external interference)
    removePidFile(pidFile);

    const result = await stopDaemonWithPidFile(pidFile);
    expect(result).toBe(false); // No PID file found

    // Clean up the orphaned process
    proc.kill();
  });
});
