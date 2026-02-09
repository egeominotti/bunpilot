// ---------------------------------------------------------------------------
// bunpm – Unit Tests: LogManager
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogManager } from '../../src/logs/manager';
import type { LogsConfig } from '../../src/config/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

function makeLogsConfig(overrides: Partial<LogsConfig> = {}): LogsConfig {
  return {
    maxSize: 1024 * 1024,
    maxFiles: 5,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogManager', () => {
  beforeEach(() => {
    tempDir = join(
      tmpdir(),
      `bunpm-test-manager-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // createWriters
  // -----------------------------------------------------------------------

  test('createWriters creates the app directory', () => {
    const manager = new LogManager(tempDir);
    const config = makeLogsConfig();

    manager.createWriters('my-app', 0, config);

    const appDir = join(tempDir, 'my-app');
    expect(existsSync(appDir)).toBe(true);

    manager.closeAll();
  });

  test('createWriters returns stdout and stderr writers', () => {
    const manager = new LogManager(tempDir);
    const config = makeLogsConfig();

    const { stdout, stderr } = manager.createWriters('web', 1, config);

    expect(stdout).toBeDefined();
    expect(stderr).toBeDefined();
    expect(typeof stdout.write).toBe('function');
    expect(typeof stderr.write).toBe('function');

    manager.closeAll();
  });

  test('createWriters uses custom outFile and errFile names', async () => {
    const manager = new LogManager(tempDir);
    const config = makeLogsConfig({
      outFile: 'custom-out.log',
      errFile: 'custom-err.log',
    });

    const { stdout, stderr } = manager.createWriters('api', 0, config);

    await stdout.write('stdout data\n');
    await stderr.write('stderr data\n');

    expect(existsSync(join(tempDir, 'api', 'custom-out.log'))).toBe(true);
    expect(existsSync(join(tempDir, 'api', 'custom-err.log'))).toBe(true);

    manager.closeAll();
  });

  // -----------------------------------------------------------------------
  // closeAll
  // -----------------------------------------------------------------------

  test('closeAll closes all writers without throwing', () => {
    const manager = new LogManager(tempDir);
    const config = makeLogsConfig();

    manager.createWriters('app-a', 0, config);
    manager.createWriters('app-b', 0, config);

    expect(() => manager.closeAll()).not.toThrow();
  });

  test('closeAll can be called multiple times safely', () => {
    const manager = new LogManager(tempDir);
    const config = makeLogsConfig();

    manager.createWriters('app', 0, config);
    manager.closeAll();

    expect(() => manager.closeAll()).not.toThrow();
  });

  // -----------------------------------------------------------------------
  // pipeOutput
  // -----------------------------------------------------------------------

  test('pipeOutput creates log files from streams', async () => {
    const manager = new LogManager(tempDir);
    const config = makeLogsConfig();

    const stdoutData = new TextEncoder().encode('stdout line\n');
    const stderrData = new TextEncoder().encode('stderr line\n');

    const stdoutStream = new ReadableStream({
      start(controller) {
        controller.enqueue(stdoutData);
        controller.close();
      },
    });

    const stderrStream = new ReadableStream({
      start(controller) {
        controller.enqueue(stderrData);
        controller.close();
      },
    });

    manager.pipeOutput('pipe-app', 0, stdoutStream, stderrStream, config, false);

    // Give the async piping a moment to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    const appDir = join(tempDir, 'pipe-app');
    expect(existsSync(appDir)).toBe(true);

    const outPath = join(appDir, 'pipe-app-0-out.log');
    const errPath = join(appDir, 'pipe-app-0-err.log');

    expect(existsSync(outPath)).toBe(true);
    expect(existsSync(errPath)).toBe(true);

    manager.closeAll();
  });

  // -----------------------------------------------------------------------
  // Bug 5: pipeOutput creates duplicate writers that leak
  // -----------------------------------------------------------------------

  test('createWriters closes old writers when called again for the same key', async () => {
    const manager = new LogManager(tempDir);
    const config = makeLogsConfig();

    // First call creates writers
    const { stdout: w1, stderr: w1err } = manager.createWriters('app', 0, config);
    await w1.write('first writer\n');

    // Second call for the same app:workerId should close old writers
    const { stdout: w2, stderr: w2err } = manager.createWriters('app', 0, config);
    await w2.write('second writer\n');

    // Old writer should be closed — writing to it should be a no-op
    await w1.write('should not appear\n');

    const content = readFileSync(join(tempDir, 'app', 'app-0-out.log'), 'utf-8');
    expect(content).toContain('first writer');
    expect(content).toContain('second writer');
    expect(content).not.toContain('should not appear');

    manager.closeAll();
  });

  // -----------------------------------------------------------------------
  // Bug 7: Custom log filenames collide across workers
  // -----------------------------------------------------------------------

  test('custom outFile gets workerId suffix for workers > 0', async () => {
    const manager = new LogManager(tempDir);
    const config = makeLogsConfig({
      outFile: 'app.log',
      errFile: 'app-err.log',
    });

    // Worker 0 uses the raw filename
    const { stdout: w0 } = manager.createWriters('myapp', 0, config);
    await w0.write('worker 0\n');

    // Worker 1 should get a distinct filename
    const { stdout: w1 } = manager.createWriters('myapp', 1, config);
    await w1.write('worker 1\n');

    const appDir = join(tempDir, 'myapp');

    // Worker 0 uses the original filename
    expect(existsSync(join(appDir, 'app.log'))).toBe(true);

    // Worker 1 should use a different filename with workerId
    expect(existsSync(join(appDir, 'app-1.log'))).toBe(true);

    const w0Content = readFileSync(join(appDir, 'app.log'), 'utf-8');
    const w1Content = readFileSync(join(appDir, 'app-1.log'), 'utf-8');

    expect(w0Content).toBe('worker 0\n');
    expect(w1Content).toBe('worker 1\n');

    manager.closeAll();
  });

  // -----------------------------------------------------------------------
  // Bug 8: pipeStream silently swallows all errors
  // -----------------------------------------------------------------------

  test('pipeStream logs unexpected errors to stderr', async () => {
    const manager = new LogManager(tempDir);
    const config = makeLogsConfig();

    // Create a stream that errors with an unexpected filesystem error
    const errorStream = new ReadableStream({
      start(controller) {
        controller.error(new Error('ENOSPC: disk full'));
      },
    });

    const normalStream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });

    // Capture stderr output
    const originalStderrWrite = process.stderr.write;
    let capturedStderr = '';
    process.stderr.write = ((chunk: string | Buffer) => {
      capturedStderr += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;

    try {
      manager.pipeOutput('err-app', 0, errorStream, normalStream, config, false);

      // Wait for the async piping to process the error
      await new Promise((resolve) => setTimeout(resolve, 300));

      // Should have logged the unexpected error
      expect(capturedStderr).toContain('ENOSPC');
    } finally {
      process.stderr.write = originalStderrWrite;
      manager.closeAll();
    }
  });
});
