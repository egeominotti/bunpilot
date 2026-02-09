// ---------------------------------------------------------------------------
// bunpm – Unit Tests: LogWriter
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, existsSync, unlinkSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogWriter } from '../../src/logs/writer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function logPath(name: string = 'test.log'): string {
  return join(tempDir, name);
}

function readLog(name: string = 'test.log'): string {
  return readFileSync(logPath(name), 'utf-8');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogWriter', () => {
  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `bunpm-test-writer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // Basic write
  // -----------------------------------------------------------------------

  test('write appends data to file', async () => {
    const writer = new LogWriter(logPath(), 1024, 3);

    await writer.write('hello world\n');

    expect(existsSync(logPath())).toBe(true);
    expect(readLog()).toBe('hello world\n');
    writer.close();
  });

  test('write multiple times accumulates data', async () => {
    const writer = new LogWriter(logPath(), 1024, 3);

    await writer.write('line 1\n');
    await writer.write('line 2\n');
    await writer.write('line 3\n');

    const content = readLog();
    expect(content).toBe('line 1\nline 2\nline 3\n');
    writer.close();
  });

  test('write accepts Uint8Array', async () => {
    const writer = new LogWriter(logPath(), 1024, 3);

    const data = new TextEncoder().encode('binary data\n');
    await writer.write(data);

    expect(readLog()).toBe('binary data\n');
    writer.close();
  });

  // -----------------------------------------------------------------------
  // Close
  // -----------------------------------------------------------------------

  test('close prevents further writes', async () => {
    const writer = new LogWriter(logPath(), 1024, 3);

    await writer.write('before close\n');
    writer.close();
    await writer.write('after close\n');

    const content = readLog();
    expect(content).toBe('before close\n');
    expect(content).not.toContain('after close');
  });

  // -----------------------------------------------------------------------
  // Rotation
  // -----------------------------------------------------------------------

  test('rotation triggers when file exceeds maxSize', async () => {
    // Use a very small maxSize so rotation triggers quickly
    const writer = new LogWriter(logPath(), 50, 3);

    // Write enough to exceed 50 bytes
    await writer.write('A'.repeat(60) + '\n');

    // Next write should trigger rotation: current -> .1, then new data in current
    await writer.write('new data\n');

    expect(existsSync(logPath())).toBe(true);
    expect(existsSync(`${logPath()}.1`)).toBe(true);

    // The rotated file should contain the original large payload
    const rotated = readFileSync(`${logPath()}.1`, 'utf-8');
    expect(rotated).toContain('A'.repeat(60));

    // The current file should contain the new data
    const current = readLog();
    expect(current).toBe('new data\n');

    writer.close();
  });

  test('rotation shifts files (.1 -> .2, current -> .1)', async () => {
    const writer = new LogWriter(logPath(), 20, 5);

    // Each payload > 20 bytes so rotation triggers on every subsequent write
    await writer.write('aaaaaaaaaaaaaaaaaaaaa\n'); // 22 bytes -> currentSize=22
    await writer.write('bbbbbbbbbbbbbbbbbbbbb\n'); // 22 >= 20, rotate, then write
    await writer.write('ccccccccccccccccccccc\n'); // 22 >= 20, rotate again

    expect(existsSync(`${logPath()}.1`)).toBe(true);
    expect(existsSync(`${logPath()}.2`)).toBe(true);

    writer.close();
  });

  test('rotation deletes oldest when maxFiles exceeded', async () => {
    const writer = new LogWriter(logPath(), 20, 2);

    await writer.write('aaaaaaaaaaaaaaaaaaaaaa\n');
    await writer.write('bbbbbbbbbbbbbbbbbbbbbb\n');
    await writer.write('cccccccccccccccccccccc\n');

    // .1 should exist (most recent rotated)
    expect(existsSync(`${logPath()}.1`)).toBe(true);

    // Files beyond maxFiles should not exist
    expect(existsSync(`${logPath()}.3`)).toBe(false);

    writer.close();
  });

  // -----------------------------------------------------------------------
  // Bug 6: Rotation race condition with concurrent writers
  // -----------------------------------------------------------------------

  test('concurrent writes do not corrupt rotation', async () => {
    const writer = new LogWriter(logPath(), 30, 3);

    // Fire multiple concurrent writes that each exceed the maxSize threshold.
    // Without a rotation guard, both would try to rotate simultaneously.
    const p1 = writer.write('A'.repeat(35) + '\n');
    const p2 = writer.write('B'.repeat(35) + '\n');

    // Should not throw or corrupt files
    await Promise.all([p1, p2]);

    // At least one rotated file should exist
    expect(existsSync(`${logPath()}.1`)).toBe(true);

    // No crash or corruption
    writer.close();
  });

  // -----------------------------------------------------------------------
  // Bug 9: Large single write exceeds maxSize before rotation
  // -----------------------------------------------------------------------

  test('large write triggers rotation after write if size exceeded', async () => {
    // maxSize = 50, but we write a 200-byte chunk in one go
    const writer = new LogWriter(logPath(), 50, 3);

    await writer.write('X'.repeat(200) + '\n');

    // After write, the post-write check should have rotated the oversized file
    expect(existsSync(`${logPath()}.1`)).toBe(true);

    // The rotated file should contain the large payload
    const rotatedContent = readFileSync(`${logPath()}.1`, 'utf-8');
    expect(rotatedContent).toContain('X'.repeat(200));

    writer.close();
  });
});
