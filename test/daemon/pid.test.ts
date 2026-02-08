// ---------------------------------------------------------------------------
// bunpm2 – Unit Tests for Daemon PID Utilities
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessRunning,
  checkStalePid,
} from '../../src/daemon/pid';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bunpm2-pid-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writePidFile / readPidFile round-trip
// ---------------------------------------------------------------------------

describe('writePidFile / readPidFile', () => {
  test('round-trip: write then read returns the same PID', () => {
    const pidFile = join(tempDir, 'test.pid');
    writePidFile(pidFile, 12345);
    const result = readPidFile(pidFile);
    expect(result).toBe(12345);
  });

  test('readPidFile returns null for missing file', () => {
    const pidFile = join(tempDir, 'nonexistent.pid');
    expect(readPidFile(pidFile)).toBeNull();
  });

  test('readPidFile returns null for invalid (non-numeric) content', () => {
    const pidFile = join(tempDir, 'bad.pid');
    writeFileSync(pidFile, 'not-a-number');
    expect(readPidFile(pidFile)).toBeNull();
  });

  test('readPidFile returns null for empty file', () => {
    const pidFile = join(tempDir, 'empty.pid');
    writeFileSync(pidFile, '');
    expect(readPidFile(pidFile)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// removePidFile
// ---------------------------------------------------------------------------

describe('removePidFile', () => {
  test('removes an existing PID file', () => {
    const pidFile = join(tempDir, 'remove.pid');
    writePidFile(pidFile, 42);
    expect(existsSync(pidFile)).toBe(true);

    removePidFile(pidFile);
    expect(existsSync(pidFile)).toBe(false);
  });

  test('does not throw when file does not exist', () => {
    const pidFile = join(tempDir, 'missing.pid');
    expect(() => removePidFile(pidFile)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isProcessRunning
// ---------------------------------------------------------------------------

describe('isProcessRunning', () => {
  test('returns true for the current process PID', () => {
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  test('returns false for a non-existent PID', () => {
    // Use a very high PID that almost certainly does not exist
    expect(isProcessRunning(99999999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkStalePid
// ---------------------------------------------------------------------------

describe('checkStalePid', () => {
  test('returns "none" when PID file does not exist', () => {
    const pidFile = join(tempDir, 'no-file.pid');
    expect(checkStalePid(pidFile)).toBe('none');
  });

  test('returns "running" when PID file points to a live process', () => {
    const pidFile = join(tempDir, 'running.pid');
    writePidFile(pidFile, process.pid);
    expect(checkStalePid(pidFile)).toBe('running');
  });

  test('returns "stale" when PID file points to a dead process', () => {
    const pidFile = join(tempDir, 'stale.pid');
    writePidFile(pidFile, 99999999);
    expect(checkStalePid(pidFile)).toBe('stale');
  });
});
