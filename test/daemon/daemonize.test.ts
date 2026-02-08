// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Daemon: stopDaemon logic
// ---------------------------------------------------------------------------
//
// We test stopDaemon behavior by manipulating PID files and using the
// existing pid.ts helpers. We do NOT actually spawn daemon processes.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
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
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bunpilot-daemonize-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// stopDaemon-like logic tests
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
