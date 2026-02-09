// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for CLI Commands
// ---------------------------------------------------------------------------
//
// Tests for: startCommand, stopCommand, restartCommand, reloadCommand,
//            deleteCommand, listCommand
//
// Strategy: each test uses mock.module() + dynamic import (await import())
// to inject mock implementations of _connect helpers per test. This avoids
// global mock pollution that would affect other test files.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { ControlResponse, AppStatus, WorkerInfo } from '../../src/config/types';

// ---------------------------------------------------------------------------
// Console Capture Utilities
// ---------------------------------------------------------------------------

type ConsoleCapture = {
  logs: string[];
  errors: string[];
  stdoutWrites: string[];
  restore: () => void;
};

function captureConsole(): ConsoleCapture {
  const captured: ConsoleCapture = {
    logs: [],
    errors: [],
    stdoutWrites: [],
    restore: () => {},
  };

  const origLog = console.log;
  const origError = console.error;
  const origStdoutWrite = process.stdout.write;

  console.log = (...args: unknown[]) => {
    captured.logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    captured.errors.push(args.map(String).join(' '));
  };
  process.stdout.write = ((chunk: unknown) => {
    captured.stdoutWrites.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  captured.restore = () => {
    console.log = origLog;
    console.error = origError;
    process.stdout.write = origStdoutWrite;
  };

  return captured;
}

// ---------------------------------------------------------------------------
// process.exit capture
// ---------------------------------------------------------------------------

let exitCalls: number[] = [];
const origExit = process.exit;

function captureExit(): void {
  exitCalls = [];
  process.exit = ((code?: number) => {
    exitCalls.push(code ?? 0);
    throw new Error(`process.exit(${code ?? 0})`);
  }) as typeof process.exit;
}

function restoreExit(): void {
  process.exit = origExit;
  exitCalls = [];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal AppStatus for mock list responses. */
function makeAppStatus(
  name: string,
  status: 'running' | 'stopped' = 'running',
): AppStatus {
  return {
    name,
    status,
    workers: [],
    config: {
      name,
      script: `${name}.ts`,
      instances: 1,
      maxRestarts: 10,
      maxRestartWindow: 60000,
      minUptime: 1000,
      backoff: { initial: 100, multiplier: 2, max: 30000 },
      killTimeout: 5000,
      shutdownSignal: 'SIGTERM',
      readyTimeout: 10000,
    },
    startedAt: Date.now(),
  };
}

/** Create a WorkerInfo with optional overrides. */
function makeWorkerInfo(overrides: Partial<WorkerInfo> = {}): WorkerInfo {
  return {
    id: 1,
    pid: 1234,
    state: 'online',
    startedAt: Date.now() - 60_000,
    readyAt: Date.now() - 59_000,
    restartCount: 0,
    consecutiveCrashes: 0,
    lastCrashAt: null,
    exitCode: null,
    signalCode: null,
    memory: null,
    cpu: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock _connect module. Tracks calls in the returned `calls` array.
 * `resultMap` maps command names to ControlResponse. Falls back to
 * `defaultResult` for any command not in the map.
 */
function buildConnectMock(opts: {
  defaultResult?: ControlResponse;
  resultMap?: Record<string, ControlResponse>;
}) {
  const calls: Array<{
    cmd: string;
    args?: Record<string, unknown>;
    opts?: { silent?: boolean };
  }> = [];

  const defaultResult: ControlResponse = opts.defaultResult ?? {
    id: 'mock-id',
    ok: true,
    data: undefined,
  };
  const resultMap = opts.resultMap ?? {};

  return {
    calls,
    module: {
      sendCommand: async (
        cmd: string,
        args?: Record<string, unknown>,
        callOpts?: { silent?: boolean },
      ) => {
        calls.push({ cmd, args, opts: callOpts });
        return resultMap[cmd] ?? defaultResult;
      },
      sendStreamCommand: async () => {},
      requireArg: (args: string[], label: string) => {
        if (!args[0]) {
          process.exit(1);
          throw new Error('process.exit');
        }
        return args[0];
      },
      createClient: () => ({}),
    },
  };
}

// ===========================================================================
// startCommand
// ===========================================================================

describe('startCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  // ---- Inline mode ----

  test('starts an app in inline mode with a script argument', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({ apps: [] }),
      loadFromCLI: () => ({
        name: 'test-app',
        script: 'app.ts',
        instances: 1,
        maxRestarts: 10,
        maxRestartWindow: 60000,
        minUptime: 1000,
        backoff: { initial: 100, multiplier: 2, max: 30000 },
        killTimeout: 5000,
        shutdownSignal: 'SIGTERM',
        readyTimeout: 10000,
      }),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();
    await startCommand(['app.ts'], {});

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('start');
    expect(tracker.calls[0].args).toHaveProperty('name', 'test-app');
    expect(tracker.calls[0].opts).toEqual({ silent: true });
  });

  test('exits with error when no script is provided in inline mode', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({ apps: [] }),
      loadFromCLI: () => ({}),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();

    try {
      await startCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
  });

  test('passes instances flag to config', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({ apps: [] }),
      loadFromCLI: () => ({
        name: 'test-app',
        script: 'app.ts',
        instances: 4,
        maxRestarts: 10,
        maxRestartWindow: 60000,
        minUptime: 1000,
        backoff: { initial: 100, multiplier: 2, max: 30000 },
        killTimeout: 5000,
        shutdownSignal: 'SIGTERM',
        readyTimeout: 10000,
      }),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();
    await startCommand(['app.ts'], { instances: '4' });

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('start');
  });

  test('handles instances=max flag', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({ apps: [] }),
      loadFromCLI: () => ({
        name: 'test-app',
        script: 'app.ts',
        instances: 'max',
        maxRestarts: 10,
        maxRestartWindow: 60000,
        minUptime: 1000,
        backoff: { initial: 100, multiplier: 2, max: 30000 },
        killTimeout: 5000,
        shutdownSignal: 'SIGTERM',
        readyTimeout: 10000,
      }),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();
    await startCommand(['app.ts'], { instances: 'max' });

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('start');
  });

  test('passes port flag to config', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({ apps: [] }),
      loadFromCLI: () => ({
        name: 'test-app',
        script: 'app.ts',
        instances: 1,
        port: 3000,
        maxRestarts: 10,
        maxRestartWindow: 60000,
        minUptime: 1000,
        backoff: { initial: 100, multiplier: 2, max: 30000 },
        killTimeout: 5000,
        shutdownSignal: 'SIGTERM',
        readyTimeout: 10000,
      }),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();
    await startCommand(['app.ts'], { port: '3000' });

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('start');
  });

  test('passes name flag to config', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({ apps: [] }),
      loadFromCLI: () => ({
        name: 'my-app',
        script: 'app.ts',
        instances: 1,
        maxRestarts: 10,
        maxRestartWindow: 60000,
        minUptime: 1000,
        backoff: { initial: 100, multiplier: 2, max: 30000 },
        killTimeout: 5000,
        shutdownSignal: 'SIGTERM',
        readyTimeout: 10000,
      }),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();
    await startCommand(['app.ts'], { name: 'my-app' });

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('start');
    expect(tracker.calls[0].args).toHaveProperty('name', 'my-app');
  });

  // ---- Config-file mode ----

  test('starts all apps from config file', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({
        apps: [
          { name: 'web', script: 'web.ts' },
          { name: 'worker', script: 'worker.ts' },
        ],
      }),
      loadFromCLI: () => ({}),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();
    await startCommand([], { config: 'bunpilot.config.ts' });

    expect(tracker.calls).toHaveLength(2);
    expect(tracker.calls[0].cmd).toBe('start');
    expect(tracker.calls[0].args).toHaveProperty('name', 'web');
    expect(tracker.calls[1].cmd).toBe('start');
    expect(tracker.calls[1].args).toHaveProperty('name', 'worker');
  });

  test('exits when config file has no apps', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({ apps: [] }),
      loadFromCLI: () => ({}),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();

    try {
      await startCommand([], { config: true });
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
  });

  test('exits when config file loading fails', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => {
        throw new Error('File not found');
      },
      loadFromCLI: () => ({}),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();

    try {
      await startCommand([], { config: 'missing.json' });
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
  });

  test('uses undefined configPath when --config is boolean true', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({
        apps: [{ name: 'app1', script: 'app.ts' }],
      }),
      loadFromCLI: () => ({}),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();
    await startCommand([], { config: true });

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].args).toHaveProperty('name', 'app1');
  });

  test('sends config object alongside name in start payload', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({
        apps: [{ name: 'api', script: 'api.ts', port: 8080 }],
      }),
      loadFromCLI: () => ({}),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();
    await startCommand([], { config: 'config.ts' });

    expect(tracker.calls[0].args).toHaveProperty('config');
    expect(
      (tracker.calls[0].args as Record<string, unknown>).config,
    ).toHaveProperty('name', 'api');
  });

  // Bug 3: parseInt produces NaN for invalid CLI flags
  test('exits with error for invalid --instances value', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({ apps: [] }),
      loadFromCLI: () => ({
        name: 'test-app',
        script: 'app.ts',
        instances: 1,
        maxRestarts: 10,
        maxRestartWindow: 60000,
        minUptime: 1000,
        backoff: { initial: 100, multiplier: 2, max: 30000 },
        killTimeout: 5000,
        shutdownSignal: 'SIGTERM',
        readyTimeout: 10000,
      }),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();

    try {
      await startCommand(['app.ts'], { instances: 'abc' });
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
    const errOutput = captured.errors.join('\n');
    expect(errOutput).toContain('Invalid --instances');
  });

  test('exits with error for invalid --port value', async () => {
    const tracker = buildConnectMock({});

    mock.module('../../src/cli/commands/_connect', () => tracker.module);
    mock.module('../../src/config/loader', () => ({
      loadConfig: async () => ({ apps: [] }),
      loadFromCLI: () => ({
        name: 'test-app',
        script: 'app.ts',
        instances: 1,
        maxRestarts: 10,
        maxRestartWindow: 60000,
        minUptime: 1000,
        backoff: { initial: 100, multiplier: 2, max: 30000 },
        killTimeout: 5000,
        shutdownSignal: 'SIGTERM',
        readyTimeout: 10000,
      }),
    }));

    const { startCommand } = await import('../../src/cli/commands/start');
    captured = captureConsole();

    try {
      await startCommand(['app.ts'], { port: 'xyz' });
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
    const errOutput = captured.errors.join('\n');
    expect(errOutput).toContain('Invalid --port');
  });
});

// ===========================================================================
// stopCommand
// ===========================================================================

describe('stopCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('stops a single app by name', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { stopCommand } = await import('../../src/cli/commands/stop');
    captured = captureConsole();
    await stopCommand(['my-app'], {});

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('stop');
    expect(tracker.calls[0].args).toEqual({ name: 'my-app' });
  });

  test('exits when no app name is given', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { stopCommand } = await import('../../src/cli/commands/stop');
    captured = captureConsole();

    try {
      await stopCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
  });

  test('stops all apps when name is "all"', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: {
          id: 'mock-list',
          ok: true,
          data: [makeAppStatus('web'), makeAppStatus('worker')],
        },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { stopCommand } = await import('../../src/cli/commands/stop');
    captured = captureConsole();
    await stopCommand(['all'], {});

    // First call is 'list', then 'stop' for each app
    expect(tracker.calls).toHaveLength(3);
    expect(tracker.calls[0].cmd).toBe('list');
    expect(tracker.calls[1].cmd).toBe('stop');
    expect(tracker.calls[1].args).toEqual({ name: 'web' });
    expect(tracker.calls[2].cmd).toBe('stop');
    expect(tracker.calls[2].args).toEqual({ name: 'worker' });
  });

  test('warns when "all" is used but no apps are running', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: { id: 'mock-list', ok: true, data: [] },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { stopCommand } = await import('../../src/cli/commands/stop');
    captured = captureConsole();
    await stopCommand(['all'], {});

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('list');
    const warnOutput = captured.logs.find((l) => l.includes('No applications running'));
    expect(warnOutput).toBeDefined();
  });

  test('handles "all" when list response data is undefined', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: { id: 'mock-list', ok: true, data: undefined },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { stopCommand } = await import('../../src/cli/commands/stop');
    captured = captureConsole();
    await stopCommand(['all'], {});

    // Should treat undefined data as empty list -> warn
    expect(tracker.calls).toHaveLength(1);
    const warnOutput = captured.logs.find((l) => l.includes('No applications running'));
    expect(warnOutput).toBeDefined();
  });
});

// ===========================================================================
// restartCommand
// ===========================================================================

describe('restartCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('restarts a single app by name', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { restartCommand } = await import('../../src/cli/commands/restart');
    captured = captureConsole();
    await restartCommand(['my-app'], {});

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('restart');
    expect(tracker.calls[0].args).toEqual({ name: 'my-app' });
  });

  test('exits when no app name is given', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { restartCommand } = await import('../../src/cli/commands/restart');
    captured = captureConsole();

    try {
      await restartCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
  });

  test('restarts all apps when name is "all"', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: {
          id: 'mock-list',
          ok: true,
          data: [makeAppStatus('api'), makeAppStatus('cron')],
        },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { restartCommand } = await import('../../src/cli/commands/restart');
    captured = captureConsole();
    await restartCommand(['all'], {});

    expect(tracker.calls).toHaveLength(3);
    expect(tracker.calls[0].cmd).toBe('list');
    expect(tracker.calls[1].cmd).toBe('restart');
    expect(tracker.calls[1].args).toEqual({ name: 'api' });
    expect(tracker.calls[2].cmd).toBe('restart');
    expect(tracker.calls[2].args).toEqual({ name: 'cron' });
  });

  test('warns when "all" is used but no apps are running', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: { id: 'mock-list', ok: true, data: [] },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { restartCommand } = await import('../../src/cli/commands/restart');
    captured = captureConsole();
    await restartCommand(['all'], {});

    expect(tracker.calls).toHaveLength(1);
    const warnOutput = captured.logs.find((l) => l.includes('No applications running'));
    expect(warnOutput).toBeDefined();
  });

  test('handles a single app with a complex name', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { restartCommand } = await import('../../src/cli/commands/restart');
    captured = captureConsole();
    await restartCommand(['my-complex-app-v2'], {});

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].args).toEqual({ name: 'my-complex-app-v2' });
  });
});

// ===========================================================================
// reloadCommand
// ===========================================================================

describe('reloadCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('reloads a single app by name', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { reloadCommand } = await import('../../src/cli/commands/reload');
    captured = captureConsole();
    await reloadCommand(['my-app'], {});

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('reload');
    expect(tracker.calls[0].args).toEqual({ name: 'my-app' });
  });

  test('exits when no app name is given', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { reloadCommand } = await import('../../src/cli/commands/reload');
    captured = captureConsole();

    try {
      await reloadCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
  });

  test('reloads all apps when name is "all"', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: {
          id: 'mock-list',
          ok: true,
          data: [makeAppStatus('frontend'), makeAppStatus('backend')],
        },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { reloadCommand } = await import('../../src/cli/commands/reload');
    captured = captureConsole();
    await reloadCommand(['all'], {});

    expect(tracker.calls).toHaveLength(3);
    expect(tracker.calls[0].cmd).toBe('list');
    expect(tracker.calls[1].cmd).toBe('reload');
    expect(tracker.calls[1].args).toEqual({ name: 'frontend' });
    expect(tracker.calls[2].cmd).toBe('reload');
    expect(tracker.calls[2].args).toEqual({ name: 'backend' });
  });

  test('warns when "all" is used but no apps are running', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: { id: 'mock-list', ok: true, data: [] },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { reloadCommand } = await import('../../src/cli/commands/reload');
    captured = captureConsole();
    await reloadCommand(['all'], {});

    expect(tracker.calls).toHaveLength(1);
    const warnOutput = captured.logs.find((l) => l.includes('No applications running'));
    expect(warnOutput).toBeDefined();
  });

  test('handles "all" with a single app', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: {
          id: 'mock-list',
          ok: true,
          data: [makeAppStatus('solo-app')],
        },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { reloadCommand } = await import('../../src/cli/commands/reload');
    captured = captureConsole();
    await reloadCommand(['all'], {});

    expect(tracker.calls).toHaveLength(2);
    expect(tracker.calls[1].cmd).toBe('reload');
    expect(tracker.calls[1].args).toEqual({ name: 'solo-app' });
  });
});

// ===========================================================================
// deleteCommand
// ===========================================================================

describe('deleteCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('deletes a single app with --force flag (no confirmation)', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { deleteCommand } = await import('../../src/cli/commands/delete');
    captured = captureConsole();
    await deleteCommand(['my-app'], { force: true });

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('delete');
    expect(tracker.calls[0].args).toEqual({ name: 'my-app' });
  });

  test('exits when no app name is given', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { deleteCommand } = await import('../../src/cli/commands/delete');
    captured = captureConsole();

    try {
      await deleteCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
  });

  test('deletes all apps with --force when name is "all"', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: {
          id: 'mock-list',
          ok: true,
          data: [makeAppStatus('app1'), makeAppStatus('app2')],
        },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { deleteCommand } = await import('../../src/cli/commands/delete');
    captured = captureConsole();
    await deleteCommand(['all'], { force: true });

    expect(tracker.calls).toHaveLength(3);
    expect(tracker.calls[0].cmd).toBe('list');
    expect(tracker.calls[1].cmd).toBe('delete');
    expect(tracker.calls[1].args).toEqual({ name: 'app1' });
    expect(tracker.calls[2].cmd).toBe('delete');
    expect(tracker.calls[2].args).toEqual({ name: 'app2' });
  });

  test('warns when "all" with --force finds no apps', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: { id: 'mock-list', ok: true, data: [] },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { deleteCommand } = await import('../../src/cli/commands/delete');
    captured = captureConsole();
    await deleteCommand(['all'], { force: true });

    expect(tracker.calls).toHaveLength(1);
    const warnOutput = captured.logs.find((l) => l.includes('No applications to delete'));
    expect(warnOutput).toBeDefined();
  });

  test('prompts for confirmation when deleting a single app without --force', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { deleteCommand } = await import('../../src/cli/commands/delete');
    captured = captureConsole();

    const deletePromise = deleteCommand(['my-app'], {});

    // Simulate user typing "n\n" to abort
    await new Promise((resolve) => setTimeout(resolve, 10));
    process.stdin.emit('data', 'n\n');

    await deletePromise;

    // Should NOT have called sendCommand('delete', ...) since user declined
    expect(tracker.calls).toHaveLength(0);
    const abortOutput = captured.logs.find((l) => l.includes('Aborted'));
    expect(abortOutput).toBeDefined();
  });

  test('proceeds with delete when user confirms with "y"', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { deleteCommand } = await import('../../src/cli/commands/delete');
    captured = captureConsole();

    const deletePromise = deleteCommand(['my-app'], {});

    await new Promise((resolve) => setTimeout(resolve, 10));
    process.stdin.emit('data', 'y\n');

    await deletePromise;

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('delete');
    expect(tracker.calls[0].args).toEqual({ name: 'my-app' });
  });

  test('prompts for confirmation when deleting all without --force', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: {
          id: 'mock-list',
          ok: true,
          data: [makeAppStatus('a1')],
        },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { deleteCommand } = await import('../../src/cli/commands/delete');
    captured = captureConsole();

    const deletePromise = deleteCommand(['all'], {});

    await new Promise((resolve) => setTimeout(resolve, 10));
    process.stdin.emit('data', 'n\n');

    await deletePromise;

    // User said "n", so only the prompt was shown, no list/delete calls
    expect(tracker.calls).toHaveLength(0);
    const abortOutput = captured.logs.find((l) => l.includes('Aborted'));
    expect(abortOutput).toBeDefined();
  });

  test('deletes all after user confirms "y" without --force', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: {
          id: 'mock-list',
          ok: true,
          data: [makeAppStatus('x'), makeAppStatus('y')],
        },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { deleteCommand } = await import('../../src/cli/commands/delete');
    captured = captureConsole();

    const deletePromise = deleteCommand(['all'], {});

    await new Promise((resolve) => setTimeout(resolve, 10));
    process.stdin.emit('data', 'y\n');

    await deletePromise;

    expect(tracker.calls).toHaveLength(3);
    expect(tracker.calls[0].cmd).toBe('list');
    expect(tracker.calls[1].cmd).toBe('delete');
    expect(tracker.calls[2].cmd).toBe('delete');
  });

  test('handles "all" with undefined data in list response', async () => {
    const tracker = buildConnectMock({
      resultMap: {
        list: { id: 'mock-list', ok: true, data: undefined },
      },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { deleteCommand } = await import('../../src/cli/commands/delete');
    captured = captureConsole();
    await deleteCommand(['all'], { force: true });

    expect(tracker.calls).toHaveLength(1); // only the list call
    const warnOutput = captured.logs.find((l) => l.includes('No applications to delete'));
    expect(warnOutput).toBeDefined();
  });
});

// ===========================================================================
// listCommand
// ===========================================================================

describe('listCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('sends list command to daemon', async () => {
    const tracker = buildConnectMock({});
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    expect(tracker.calls).toHaveLength(1);
    expect(tracker.calls[0].cmd).toBe('list');
    expect(tracker.calls[0].opts).toEqual({ silent: true });
  });

  test('outputs JSON when --json flag is set', async () => {
    const apps = [makeAppStatus('api')];
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: apps },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], { json: true });

    expect(captured.logs).toContain(JSON.stringify(apps, null, 2));
  });

  test('warns when no apps are running (no --json)', async () => {
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: [] },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    const warnOutput = captured.logs.find((l) => l.includes('No applications running'));
    expect(warnOutput).toBeDefined();
  });

  test('outputs empty JSON array when --json and no apps', async () => {
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: [] },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], { json: true });

    expect(captured.logs).toContain(JSON.stringify([], null, 2));
  });

  test('outputs table when apps have no workers', async () => {
    const apps = [makeAppStatus('web', 'running')];
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: apps },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    const tableOutput = captured.logs.find((l) => l.includes('NAME'));
    expect(tableOutput).toBeDefined();
  });

  test('outputs table with worker details', async () => {
    const app = makeAppStatus('api', 'running');
    app.workers = [
      makeWorkerInfo({
        id: 1,
        pid: 5678,
        state: 'online',
        restartCount: 2,
        memory: {
          rss: 50 * 1024 * 1024,
          heapTotal: 30 * 1024 * 1024,
          heapUsed: 20 * 1024 * 1024,
          external: 0,
          timestamp: Date.now(),
        },
        cpu: {
          user: 100,
          system: 50,
          percentage: 12.5,
          timestamp: Date.now(),
        },
      }),
    ];
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: [app] },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    const tableOutput = captured.logs.find((l) => l.includes('NAME'));
    expect(tableOutput).toBeDefined();
    // Should contain the app name and PID
    expect(tableOutput).toContain('api');
    expect(tableOutput).toContain('5678');
    // Should contain CPU percentage
    expect(tableOutput).toContain('12.5%');
    // Should contain restart count
    expect(tableOutput).toContain('2');
  });

  test('formats multiple workers for the same app', async () => {
    const app = makeAppStatus('cluster-app', 'running');
    app.workers = [
      makeWorkerInfo({ id: 1, pid: 1001, state: 'online', restartCount: 0 }),
      makeWorkerInfo({ id: 2, pid: 1002, state: 'online', restartCount: 1 }),
      makeWorkerInfo({ id: 3, pid: 1003, state: 'stopped', restartCount: 3 }),
    ];
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: [app] },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    const tableOutput = captured.logs.find((l) => l.includes('NAME'));
    expect(tableOutput).toBeDefined();
    expect(tableOutput).toContain('1001');
    expect(tableOutput).toContain('1002');
    expect(tableOutput).toContain('1003');
  });

  test('handles apps with stopped status and no workers', async () => {
    const app = makeAppStatus('stopped-app', 'stopped');
    app.workers = [];
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: [app] },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    const tableOutput = captured.logs.find((l) => l.includes('NAME'));
    expect(tableOutput).toBeDefined();
    expect(tableOutput).toContain('stopped-app');
    // The em dash for missing PID
    expect(tableOutput).toContain('\u2014');
  });

  // Bug 2: errored status should display as "errored", not "stopped"
  test('displays "errored" status for errored apps with no workers', async () => {
    const app: AppStatus = {
      name: 'errored-app',
      status: 'errored',
      workers: [],
      config: {
        name: 'errored-app',
        script: 'errored.ts',
        instances: 1,
        maxRestarts: 10,
        maxRestartWindow: 60000,
        minUptime: 1000,
        backoff: { initial: 100, multiplier: 2, max: 30000 },
        killTimeout: 5000,
        shutdownSignal: 'SIGTERM',
        readyTimeout: 10000,
      },
      startedAt: Date.now(),
    };
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: [app] },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    const tableOutput = captured.logs.find((l) => l.includes('NAME'));
    expect(tableOutput).toBeDefined();
    expect(tableOutput).toContain('errored');
    // Should NOT show as "stopped"
    // Note: We can't easily check the exact absence because "stopped" might appear
    // in other parts. We verify "errored" is present.
  });

  test('shows worker with null memory and cpu as dashes', async () => {
    const app = makeAppStatus('app', 'running');
    app.workers = [
      makeWorkerInfo({ id: 1, pid: 9999, memory: null, cpu: null }),
    ];
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: [app] },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    const tableOutput = captured.logs.find((l) => l.includes('NAME'));
    expect(tableOutput).toBeDefined();
    expect(tableOutput).toContain('9999');
  });

  test('handles data being undefined in response', async () => {
    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: undefined },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    const warnOutput = captured.logs.find((l) => l.includes('No applications running'));
    expect(warnOutput).toBeDefined();
  });

  test('displays multiple apps in the table', async () => {
    const app1 = makeAppStatus('api', 'running');
    app1.workers = [makeWorkerInfo({ id: 1, pid: 2001 })];
    const app2 = makeAppStatus('web', 'running');
    app2.workers = [makeWorkerInfo({ id: 1, pid: 3001 })];

    const tracker = buildConnectMock({
      defaultResult: { id: 'mock-id', ok: true, data: [app1, app2] },
    });
    mock.module('../../src/cli/commands/_connect', () => tracker.module);

    const { listCommand } = await import('../../src/cli/commands/list');
    captured = captureConsole();
    await listCommand([], {});

    const tableOutput = captured.logs.find((l) => l.includes('NAME'));
    expect(tableOutput).toBeDefined();
    expect(tableOutput).toContain('api');
    expect(tableOutput).toContain('web');
    expect(tableOutput).toContain('2001');
    expect(tableOutput).toContain('3001');
  });
});

// ===========================================================================
// Cross-cutting: stop/restart/reload share the same "all" pattern
// ===========================================================================

describe('shared "all" keyword behavior', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('stop, restart, reload all iterate through apps from list', async () => {
    const listResult: ControlResponse = {
      id: 'mock-list',
      ok: true,
      data: [makeAppStatus('svc1'), makeAppStatus('svc2'), makeAppStatus('svc3')],
    };

    // Test stop all
    const stopTracker = buildConnectMock({ resultMap: { list: listResult } });
    mock.module('../../src/cli/commands/_connect', () => stopTracker.module);
    const { stopCommand } = await import('../../src/cli/commands/stop');
    captured = captureConsole();
    await stopCommand(['all'], {});
    captured.restore();

    const stopCalls = stopTracker.calls.filter((c) => c.cmd === 'stop');
    expect(stopCalls).toHaveLength(3);

    // Test restart all
    const restartTracker = buildConnectMock({ resultMap: { list: listResult } });
    mock.module('../../src/cli/commands/_connect', () => restartTracker.module);
    const { restartCommand } = await import('../../src/cli/commands/restart');
    captured = captureConsole();
    await restartCommand(['all'], {});
    captured.restore();

    const restartCalls = restartTracker.calls.filter((c) => c.cmd === 'restart');
    expect(restartCalls).toHaveLength(3);

    // Test reload all
    const reloadTracker = buildConnectMock({ resultMap: { list: listResult } });
    mock.module('../../src/cli/commands/_connect', () => reloadTracker.module);
    const { reloadCommand } = await import('../../src/cli/commands/reload');
    captured = captureConsole();
    await reloadCommand(['all'], {});
    captured.restore();

    const reloadCalls = reloadTracker.calls.filter((c) => c.cmd === 'reload');
    expect(reloadCalls).toHaveLength(3);
  });
});
