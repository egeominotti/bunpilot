// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Daemon PID Utilities
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkStalePid,
  isBunpilotProcess,
  isProcessRunning,
  readPidFile,
  removePidFile,
  writePidFile,
} from '../../src/daemon/pid';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bunpilot-pid-test-'));
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

  test('readPidFile rejects partial, zero, negative, and unsafe PIDs', () => {
    const pidFile = join(tempDir, 'strict.pid');
    for (const value of ['123abc', '0', '-1', '9007199254740992']) {
      writeFileSync(pidFile, value);
      expect(readPidFile(pidFile)).toBeNull();
    }
  });

  test('writePidFile rejects invalid PIDs', () => {
    expect(() => writePidFile(join(tempDir, 'invalid.pid'), 0)).toThrow();
    expect(() => writePidFile(join(tempDir, 'invalid.pid'), -1)).toThrow();
  });

  test('writes PID files with owner-only permissions even under a permissive umask', () => {
    const pidFile = join(tempDir, 'private.pid');
    const previousUmask = process.umask(0);
    try {
      writePidFile(pidFile, 12345);
    } finally {
      process.umask(previousUmask);
    }

    expect(statSync(pidFile).mode & 0o777).toBe(0o600);
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

  test('does not remove a PID file that now belongs to a replacement daemon', () => {
    const pidFile = join(tempDir, 'replacement.pid');
    writePidFile(pidFile, 222);

    removePidFile(pidFile, 111);

    expect(readPidFile(pidFile)).toBe(222);
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

  test('returns false for invalid PIDs without signaling a process group', () => {
    expect(isProcessRunning(0)).toBe(false);
    expect(isProcessRunning(-1)).toBe(false);
    expect(isProcessRunning(Number.NaN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isBunpilotProcess – Bug 10: PID reuse detection
// ---------------------------------------------------------------------------

describe('isBunpilotProcess', () => {
  test('does not trust an unrelated process merely because an argument contains bunpilot', () => {
    const proc = Bun.spawn({
      cmd: ['bun', '-e', 'await Bun.sleep(60_000)', 'bunpilot-daemon-marker'],
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      expect(isBunpilotProcess(proc.pid)).toBe(false);
    } finally {
      proc.kill();
    }
  });

  test('recognizes a Bunpilot-marked process with the hidden daemon command', () => {
    const proc = Bun.spawn({
      cmd: ['bun', '-e', 'await Bun.sleep(60_000)', 'bunpilot-daemon-marker', '__daemon'],
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
      expect(isBunpilotProcess(proc.pid)).toBe(true);
    } finally {
      proc.kill();
    }
  });

  test('returns false for a non-bun process', () => {
    // Spawn a non-bun process (sleep)
    const proc = Bun.spawn({
      cmd: ['sleep', '60'],
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const pid = proc.pid;

    try {
      expect(isBunpilotProcess(pid)).toBe(false);
    } finally {
      proc.kill();
    }
  });

  test('returns false for a non-existent PID', () => {
    expect(isBunpilotProcess(99999999)).toBe(false);
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
