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

function readLogLines(logsDir: string, appName: string, maxLines: number): string[] {
  const appDir = join(logsDir, appName);
  if (!existsSync(appDir)) return [];

  const files = readdirSync(appDir)
    .filter((f) => f.endsWith('.log'))
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
});
