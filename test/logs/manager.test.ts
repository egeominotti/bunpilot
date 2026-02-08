// ---------------------------------------------------------------------------
// bunpm – Unit Tests: LogManager
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
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
});
