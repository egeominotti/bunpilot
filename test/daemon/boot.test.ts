// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Daemon Boot: readLogLines logic
// ---------------------------------------------------------------------------
//
// boot.ts is an entry point script that cannot be imported directly.
// Instead, we replicate the readLogLines helper logic inline and test it
// against real temp directories and log files.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Replicate readLogLines from boot.ts (private function, not exported)
// ---------------------------------------------------------------------------

/**
 * Extract the rotation index from a log filename.
 * - `app-0-out.log`   → -1  (current / newest)
 * - `app-0-out.0.log` → 0
 * - `app-0-out.2.log` → 2   (oldest)
 */
function rotationIndex(filename: string): number {
  const match = filename.match(/\.(\d+)\.log$/);
  return match ? parseInt(match[1], 10) : -1;
}

/**
 * Compare rotated log filenames so oldest content comes first.
 */
function compareRotatedLogs(a: string, b: string): number {
  const idxA = rotationIndex(a);
  const idxB = rotationIndex(b);

  const baseA = a.replace(/(\.\d+)?\.log$/, '');
  const baseB = b.replace(/(\.\d+)?\.log$/, '');

  if (baseA !== baseB) return baseA.localeCompare(baseB);
  return idxB - idxA;
}

function readLogLines(logsDir: string, appName: string, maxLines: number): string[] {
  const appDir = join(logsDir, appName);
  if (!existsSync(appDir)) return [];

  const files = readdirSync(appDir)
    .filter((f) => f.endsWith('.log'))
    .sort(compareRotatedLogs)
    .map((f) => join(appDir, f));

  if (files.length === 0) return [];

  const allLines: string[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      allLines.push(...lines);
    } catch {
      // File may have been rotated/deleted
    }
  }

  // Return last N lines
  return allLines.slice(-maxLines);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bunpilot-boot-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('readLogLines', () => {
  test('returns empty array when app dir does not exist', () => {
    const result = readLogLines(tempDir, 'nonexistent-app', 50);
    expect(result).toEqual([]);
  });

  test('returns empty array when app dir is empty', () => {
    const appDir = join(tempDir, 'empty-app');
    mkdirSync(appDir, { recursive: true });

    const result = readLogLines(tempDir, 'empty-app', 50);
    expect(result).toEqual([]);
  });

  test('returns empty array when app dir has no .log files', () => {
    const appDir = join(tempDir, 'no-logs');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'readme.txt'), 'not a log file');

    const result = readLogLines(tempDir, 'no-logs', 50);
    expect(result).toEqual([]);
  });

  test('reads lines from a single log file', () => {
    const appDir = join(tempDir, 'my-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'out.log'), 'line1\nline2\nline3\n');

    const result = readLogLines(tempDir, 'my-app', 50);
    expect(result).toEqual(['line1', 'line2', 'line3']);
  });

  test('reads lines from multiple log files', () => {
    const appDir = join(tempDir, 'multi-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'a.log'), 'alpha1\nalpha2\n');
    writeFileSync(join(appDir, 'b.log'), 'beta1\nbeta2\n');

    const result = readLogLines(tempDir, 'multi-app', 50);
    // Files are read in directory listing order; all lines should be present
    expect(result.length).toBe(4);
    expect(result).toContain('alpha1');
    expect(result).toContain('alpha2');
    expect(result).toContain('beta1');
    expect(result).toContain('beta2');
  });

  test('returns only last N lines when maxLines is smaller than total', () => {
    const appDir = join(tempDir, 'truncated-app');
    mkdirSync(appDir, { recursive: true });

    const lines = Array.from({ length: 100 }, (_, i) => `line-${i + 1}`);
    writeFileSync(join(appDir, 'out.log'), lines.join('\n') + '\n');

    const result = readLogLines(tempDir, 'truncated-app', 5);
    expect(result.length).toBe(5);
    expect(result[0]).toBe('line-96');
    expect(result[4]).toBe('line-100');
  });

  test('filters out empty lines from log content', () => {
    const appDir = join(tempDir, 'empty-lines-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'out.log'), 'a\n\n\nb\n\nc\n');

    const result = readLogLines(tempDir, 'empty-lines-app', 50);
    expect(result).toEqual(['a', 'b', 'c']);
  });

  test('handles log file with no trailing newline', () => {
    const appDir = join(tempDir, 'no-newline-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'out.log'), 'line1\nline2');

    const result = readLogLines(tempDir, 'no-newline-app', 50);
    expect(result).toEqual(['line1', 'line2']);
  });

  test('ignores non-.log files in the app dir', () => {
    const appDir = join(tempDir, 'mixed-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'out.log'), 'logline\n');
    writeFileSync(join(appDir, 'data.txt'), 'textline\n');
    writeFileSync(join(appDir, 'config.json'), '{"key":"value"}\n');

    const result = readLogLines(tempDir, 'mixed-app', 50);
    expect(result).toEqual(['logline']);
  });

  test('maxLines of 1 returns only the last line', () => {
    const appDir = join(tempDir, 'one-app');
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(appDir, 'out.log'), 'line1\nline2\nline3\n');

    const result = readLogLines(tempDir, 'one-app', 1);
    expect(result).toEqual(['line3']);
  });

  // -------------------------------------------------------------------------
  // Bug: rotated log files must be sorted chronologically
  // -------------------------------------------------------------------------

  test('reads rotated log files in chronological order (oldest rotation first)', () => {
    const appDir = join(tempDir, 'rotated-app');
    mkdirSync(appDir, { recursive: true });

    // Rotated logs naming convention: base.log is newest, base.0.log is next,
    // base.1.log is older, base.2.log is oldest.
    // Chronological read order should be: .2 -> .1 -> .0 -> base (newest last)
    writeFileSync(join(appDir, 'app-0-out.2.log'), 'oldest-line-1\noldest-line-2\n');
    writeFileSync(join(appDir, 'app-0-out.1.log'), 'older-line-1\nolder-line-2\n');
    writeFileSync(join(appDir, 'app-0-out.0.log'), 'old-line-1\nold-line-2\n');
    writeFileSync(join(appDir, 'app-0-out.log'), 'newest-line-1\nnewest-line-2\n');

    const result = readLogLines(tempDir, 'rotated-app', 50);

    // All 8 lines in chronological order
    expect(result).toEqual([
      'oldest-line-1',
      'oldest-line-2',
      'older-line-1',
      'older-line-2',
      'old-line-1',
      'old-line-2',
      'newest-line-1',
      'newest-line-2',
    ]);
  });

  test('last N lines from rotated logs come from most recent files', () => {
    const appDir = join(tempDir, 'rotated-tail-app');
    mkdirSync(appDir, { recursive: true });

    // 3 lines per file, 4 files = 12 lines total
    writeFileSync(join(appDir, 'app-0-out.2.log'), 'A1\nA2\nA3\n');
    writeFileSync(join(appDir, 'app-0-out.1.log'), 'B1\nB2\nB3\n');
    writeFileSync(join(appDir, 'app-0-out.0.log'), 'C1\nC2\nC3\n');
    writeFileSync(join(appDir, 'app-0-out.log'), 'D1\nD2\nD3\n');

    // Request only 4 lines — should come from the two newest files
    const result = readLogLines(tempDir, 'rotated-tail-app', 4);
    expect(result).toEqual(['C3', 'D1', 'D2', 'D3']);
  });

  test('sorts mixed stdout and stderr rotated files correctly', () => {
    const appDir = join(tempDir, 'mixed-rotate-app');
    mkdirSync(appDir, { recursive: true });

    // stdout and stderr rotated files
    writeFileSync(join(appDir, 'app-0-out.1.log'), 'out-old-1\n');
    writeFileSync(join(appDir, 'app-0-out.0.log'), 'out-recent-1\n');
    writeFileSync(join(appDir, 'app-0-out.log'), 'out-current-1\n');
    writeFileSync(join(appDir, 'app-0-err.1.log'), 'err-old-1\n');
    writeFileSync(join(appDir, 'app-0-err.0.log'), 'err-recent-1\n');
    writeFileSync(join(appDir, 'app-0-err.log'), 'err-current-1\n');

    const result = readLogLines(tempDir, 'mixed-rotate-app', 50);

    // Each file group should be internally sorted: .1 before .0 before base
    // Out files come before err files (alphabetical by base name)
    // The key assertion: within each base name, rotation order is oldest first
    const outIdx0 = result.indexOf('out-old-1');
    const outIdx1 = result.indexOf('out-recent-1');
    const outIdx2 = result.indexOf('out-current-1');
    const errIdx0 = result.indexOf('err-old-1');
    const errIdx1 = result.indexOf('err-recent-1');
    const errIdx2 = result.indexOf('err-current-1');

    // Within each group, order should be: oldest (.1) < recent (.0) < current (base)
    expect(outIdx0).toBeLessThan(outIdx1);
    expect(outIdx1).toBeLessThan(outIdx2);
    expect(errIdx0).toBeLessThan(errIdx1);
    expect(errIdx1).toBeLessThan(errIdx2);
  });
});

// ---------------------------------------------------------------------------
// Bug 1: pendingConfigs deleted before master.startApp succeeds
// ---------------------------------------------------------------------------
//
// Replicates the startApp handler logic from boot.ts to verify that
// pendingConfigs is NOT deleted when startApp throws. After the fix,
// the config should remain in pendingConfigs so a retry can succeed.
// ---------------------------------------------------------------------------

describe('startApp handler – pendingConfigs lifecycle', () => {
  interface FakeAppConfig {
    name: string;
    script: string;
  }

  // Minimal store stub
  const store = {
    saved: new Map<string, FakeAppConfig>(),
    saveApp(name: string, config: FakeAppConfig) {
      this.saved.set(name, config);
    },
    reset() {
      this.saved.clear();
    },
  };

  /**
   * Build a startApp handler identical to the FIXED boot.ts logic.
   * The fix: pendingConfigs.delete(name) is called AFTER master.startApp succeeds.
   */
  function buildStartAppHandler(
    pendingConfigs: Map<string, FakeAppConfig>,
    masterStartApp: (config: FakeAppConfig) => Promise<void>,
  ) {
    return async (name: string) => {
      const config = pendingConfigs.get(name);
      if (!config) throw new Error(`No config found for app "${name}"`);
      store.saveApp(name, config);
      await masterStartApp(config);
      pendingConfigs.delete(name); // delete AFTER success
    };
  }

  test('config remains in pendingConfigs when startApp throws', async () => {
    const pendingConfigs = new Map<string, FakeAppConfig>();
    const config: FakeAppConfig = { name: 'my-app', script: 'app.ts' };
    pendingConfigs.set('my-app', config);
    store.reset();

    const failingMaster = async (_cfg: FakeAppConfig) => {
      throw new Error('EADDRINUSE: address already in use');
    };

    const handler = buildStartAppHandler(pendingConfigs, failingMaster);

    // First attempt should throw
    await expect(handler('my-app')).rejects.toThrow('EADDRINUSE');

    // BUG FIX VERIFICATION: config should still be in pendingConfigs
    expect(pendingConfigs.has('my-app')).toBe(true);
    expect(pendingConfigs.get('my-app')).toEqual(config);
  });

  test('config is removed from pendingConfigs when startApp succeeds', async () => {
    const pendingConfigs = new Map<string, FakeAppConfig>();
    const config: FakeAppConfig = { name: 'my-app', script: 'app.ts' };
    pendingConfigs.set('my-app', config);
    store.reset();

    const succeedingMaster = async (_cfg: FakeAppConfig) => {
      // success – no throw
    };

    const handler = buildStartAppHandler(pendingConfigs, succeedingMaster);

    await handler('my-app');

    // Config should be removed after success
    expect(pendingConfigs.has('my-app')).toBe(false);
  });

  test('retry succeeds after first attempt fails', async () => {
    const pendingConfigs = new Map<string, FakeAppConfig>();
    const config: FakeAppConfig = { name: 'my-app', script: 'app.ts' };
    pendingConfigs.set('my-app', config);
    store.reset();

    let callCount = 0;
    const flakyMaster = async (_cfg: FakeAppConfig) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('EADDRINUSE: address already in use');
      }
      // second call succeeds
    };

    const handler = buildStartAppHandler(pendingConfigs, flakyMaster);

    // First attempt fails
    await expect(handler('my-app')).rejects.toThrow('EADDRINUSE');
    expect(pendingConfigs.has('my-app')).toBe(true);

    // Retry should succeed because config is still present
    await handler('my-app');
    expect(pendingConfigs.has('my-app')).toBe(false);
    expect(callCount).toBe(2);
  });

  test('throws "No config found" when name is not in pendingConfigs', async () => {
    const pendingConfigs = new Map<string, FakeAppConfig>();
    store.reset();

    const handler = buildStartAppHandler(pendingConfigs, async () => {});

    await expect(handler('missing-app')).rejects.toThrow(
      'No config found for app "missing-app"',
    );
  });
});

// ---------------------------------------------------------------------------
// Bug 2: Config load error silently swallowed
// ---------------------------------------------------------------------------
//
// Replicates the config-loading catch block from boot.ts. The bug: the catch
// block used `catch { ... }` without binding the error, losing the actual
// error message. The fix: `catch (err) { console.warn(..., err.message) }`.
// ---------------------------------------------------------------------------

describe('config load error logging', () => {
  /**
   * Simulates the FIXED config loading logic from boot.ts.
   * The fix: errors are caught with `(err)` and the message is logged.
   */
  async function loadConfigWithLogging(
    loadFn: () => Promise<{ apps: { name: string }[] }>,
    log: (msg: string) => void,
    warn: (msg: string, detail: string) => void,
  ): Promise<void> {
    try {
      const config = await loadFn();
      for (const app of config.apps) {
        log(`[daemon] auto-starting "${app.name}" from config`);
      }
    } catch (err) {
      warn(
        '[daemon] config load failed:',
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  test('logs the actual error message when config loading fails', async () => {
    const warnings: Array<{ msg: string; detail: string }> = [];

    await loadConfigWithLogging(
      async () => {
        throw new SyntaxError('Unexpected token at position 42');
      },
      () => {},
      (msg, detail) => warnings.push({ msg, detail }),
    );

    expect(warnings.length).toBe(1);
    expect(warnings[0].msg).toBe('[daemon] config load failed:');
    expect(warnings[0].detail).toContain('Unexpected token at position 42');
  });

  test('logs non-Error thrown values as strings', async () => {
    const warnings: Array<{ msg: string; detail: string }> = [];

    await loadConfigWithLogging(
      async () => {
        throw 'file not found';
      },
      () => {},
      (msg, detail) => warnings.push({ msg, detail }),
    );

    expect(warnings.length).toBe(1);
    expect(warnings[0].detail).toBe('file not found');
  });

  test('does not log warning when config loads successfully', async () => {
    const warnings: Array<{ msg: string; detail: string }> = [];
    const logs: string[] = [];

    await loadConfigWithLogging(
      async () => ({ apps: [{ name: 'test-app' }] }),
      (msg) => logs.push(msg),
      (msg, detail) => warnings.push({ msg, detail }),
    );

    expect(warnings.length).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain('test-app');
  });
});
