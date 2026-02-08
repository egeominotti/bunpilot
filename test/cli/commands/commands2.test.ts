// ---------------------------------------------------------------------------
// bunpilot – CLI Command Tests: status, logs, metrics, daemon, ping, init
// ---------------------------------------------------------------------------
//
// Tests for the remaining CLI command functions. Each command is tested by
// mocking the _connect helpers (sendCommand, requireArg) or the daemon/pid
// modules and capturing console output.
//
// IMPORTANT: This file uses mock.module() to replace _connect globally.
// It is placed in test/cli/commands/ (a subdirectory) to avoid polluting
// the module registry for test/cli/connect.test.ts, which imports _connect
// directly.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Global Teardown – restore all mocked modules so they don't leak to other
// test files that may run in the same Bun process.
// ---------------------------------------------------------------------------

afterAll(() => {
  mock.restore();
});

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
// Test Fixtures
// ---------------------------------------------------------------------------

function makeWorkerInfo(overrides: Record<string, unknown> = {}) {
  return {
    id: 0,
    pid: 1234,
    state: 'online' as const,
    startedAt: Date.now() - 60_000,
    readyAt: Date.now() - 59_000,
    restartCount: 0,
    consecutiveCrashes: 0,
    lastCrashAt: null,
    exitCode: null,
    signalCode: null,
    memory: {
      rss: 50 * 1024 * 1024,
      heapTotal: 30 * 1024 * 1024,
      heapUsed: 20 * 1024 * 1024,
      external: 1024 * 1024,
      timestamp: Date.now(),
    },
    cpu: { user: 100, system: 50, percentage: 2.5, timestamp: Date.now() },
    ...overrides,
  };
}

function makeAppConfig(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-app',
    script: './src/index.ts',
    instances: 2,
    port: 3000,
    cwd: '/home/user/project',
    maxRestarts: 15,
    maxRestartWindow: 900_000,
    minUptime: 30_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 1000, multiplier: 2, max: 30000 },
    ...overrides,
  };
}

function makeAppStatus(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-app',
    status: 'running' as const,
    workers: [makeWorkerInfo({ id: 0 }), makeWorkerInfo({ id: 1, pid: 1235 })],
    config: makeAppConfig(),
    startedAt: Date.now() - 120_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock helper: set up _connect mock with given sendCommand/requireArg
// ---------------------------------------------------------------------------

function mockConnect(overrides: {
  sendCommand?: (...args: unknown[]) => Promise<unknown>;
  requireArg?: (args: string[], label: string) => string;
} = {}) {
  mock.module('../../../src/cli/commands/_connect', () => ({
    sendCommand: overrides.sendCommand ?? (async () => ({ id: '1', ok: true, data: null })),
    requireArg: overrides.requireArg ?? ((args: string[]) => args[0]),
    createClient: () => ({}),
    sendStreamCommand: async () => {},
  }));
}

// ---------------------------------------------------------------------------
// statusCommand
// ---------------------------------------------------------------------------

describe('statusCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('prints app-level info and worker table for a running app', async () => {
    const appStatus = makeAppStatus();

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: appStatus }),
      requireArg: (args: string[]) => {
        if (!args[0]) throw new Error('missing');
        return args[0];
      },
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();
    await statusCommand(['test-app'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('test-app');
    expect(allOutput).toContain('./src/index.ts');
    expect(allOutput).toContain('2');
    expect(allOutput).toContain('3000');
  });

  test('prints cwd when present in config', async () => {
    const appStatus = makeAppStatus();

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: appStatus }),
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();
    await statusCommand(['test-app'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('/home/user/project');
  });

  test('prints "No workers" when workers array is empty', async () => {
    const appStatus = makeAppStatus({ workers: [] });

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: appStatus }),
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();
    await statusCommand(['test-app'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('No workers');
  });

  test('shows "stopped" state when app status is stopped', async () => {
    const appStatus = makeAppStatus({ status: 'stopped', startedAt: null });

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: appStatus }),
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();
    await statusCommand(['test-app'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('stopped');
  });

  test('does not print port when port is not defined', async () => {
    const appStatus = makeAppStatus({
      config: makeAppConfig({ port: undefined }),
    });

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: appStatus }),
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();
    await statusCommand(['test-app'], {});

    const portLogLine = captured.logs.find(
      (l) => l.includes('port') && l.includes('3000'),
    );
    expect(portLogLine).toBeUndefined();
  });

  test('does not print uptime when startedAt is null', async () => {
    const appStatus = makeAppStatus({ startedAt: null });

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: appStatus }),
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();
    await statusCommand(['test-app'], {});

    const uptimeLine = captured.logs.find((l) => l.includes('uptime'));
    expect(uptimeLine).toBeUndefined();
  });

  test('shows worker rows with dashes when metrics are null', async () => {
    const worker = makeWorkerInfo({ cpu: null, memory: null });
    const appStatus = makeAppStatus({ workers: [worker] });

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: appStatus }),
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();
    await statusCommand(['test-app'], {});

    const allOutput = captured.logs.join('\n');
    // \u2014 is the em-dash used when cpu/memory are null
    expect(allOutput).toContain('\u2014');
  });

  test('exits with error when requireArg throws (no app name)', async () => {
    mockConnect({
      requireArg: () => {
        process.exit(1);
        throw new Error('unreachable');
      },
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();

    try {
      await statusCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
  });

  test('shows worker PID as dash when pid is null', async () => {
    const worker = makeWorkerInfo({ pid: null });
    const appStatus = makeAppStatus({ workers: [worker] });

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: appStatus }),
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();
    await statusCommand(['test-app'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('\u2014');
  });
});

// ---------------------------------------------------------------------------
// logsCommand
// ---------------------------------------------------------------------------

describe('logsCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('displays log lines from sendCommand response', async () => {
    const logData = [
      '[INFO] Server started on port 3000',
      '[INFO] Connected to database',
      '[WARN] Memory usage high',
    ];

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: logData }),
      requireArg: (args: string[]) => {
        if (!args[0]) {
          process.exit(1);
          throw new Error('process.exit');
        }
        return args[0];
      },
    });

    const { logsCommand } = await import('../../../src/cli/commands/logs');

    captured = captureConsole();
    await logsCommand(['my-app'], {});

    // logsCommand writes each line with process.stdout.write
    expect(captured.stdoutWrites.length).toBe(3);
    expect(captured.stdoutWrites[0]).toContain('[INFO] Server started on port 3000');
    expect(captured.stdoutWrites[1]).toContain('[INFO] Connected to database');
    expect(captured.stdoutWrites[2]).toContain('[WARN] Memory usage high');
  });

  test('prints "(no logs)" when log lines array is empty', async () => {
    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: [] }),
    });

    const { logsCommand } = await import('../../../src/cli/commands/logs');

    captured = captureConsole();
    await logsCommand(['my-app'], {});

    expect(captured.logs).toContain('(no logs)');
  });

  test('prints "(no logs)" when data is null/undefined', async () => {
    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: null }),
    });

    const { logsCommand } = await import('../../../src/cli/commands/logs');

    captured = captureConsole();
    await logsCommand(['my-app'], {});

    expect(captured.logs).toContain('(no logs)');
  });

  test('passes custom lines count from flags', async () => {
    let capturedArgs: Record<string, unknown> | undefined;

    mockConnect({
      sendCommand: async (_cmd: unknown, args: unknown) => {
        capturedArgs = args as Record<string, unknown>;
        return { id: '1', ok: true, data: ['line1'] };
      },
    });

    const { logsCommand } = await import('../../../src/cli/commands/logs');

    captured = captureConsole();
    await logsCommand(['my-app'], { lines: '100' });

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.lines).toBe(100);
  });

  test('uses default 50 lines when no --lines flag', async () => {
    let capturedArgs: Record<string, unknown> | undefined;

    mockConnect({
      sendCommand: async (_cmd: unknown, args: unknown) => {
        capturedArgs = args as Record<string, unknown>;
        return { id: '1', ok: true, data: [] };
      },
    });

    const { logsCommand } = await import('../../../src/cli/commands/logs');

    captured = captureConsole();
    await logsCommand(['my-app'], {});

    expect(capturedArgs).toBeDefined();
    expect(capturedArgs!.lines).toBe(50);
  });

  test('exits with error when app name is missing', async () => {
    mockConnect({
      requireArg: () => {
        process.exit(1);
        throw new Error('process.exit');
      },
    });

    const { logsCommand } = await import('../../../src/cli/commands/logs');

    captured = captureConsole();

    try {
      await logsCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
  });

  test('sends command name "logs" to daemon', async () => {
    let capturedCmd: unknown;

    mockConnect({
      sendCommand: async (cmd: unknown) => {
        capturedCmd = cmd;
        return { id: '1', ok: true, data: [] };
      },
    });

    const { logsCommand } = await import('../../../src/cli/commands/logs');

    captured = captureConsole();
    await logsCommand(['my-app'], {});

    expect(capturedCmd).toBe('logs');
  });
});

// ---------------------------------------------------------------------------
// metricsCommand
// ---------------------------------------------------------------------------

describe('metricsCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('prints table output with worker metrics', async () => {
    const apps = [makeAppStatus()];

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: apps }),
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand(['test-app'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('APP');
    expect(allOutput).toContain('WORKER');
    expect(allOutput).toContain('PID');
    expect(allOutput).toContain('CPU');
    expect(allOutput).toContain('RSS');
    expect(allOutput).toContain('test-app');
  });

  test('outputs JSON when --json flag is set', async () => {
    const apps = [makeAppStatus()];

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: apps }),
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand(['test-app'], { json: true });

    const jsonOutput = captured.logs.join('\n');
    const parsed = JSON.parse(jsonOutput);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed[0].name).toBe('test-app');
  });

  test('outputs Prometheus exposition format when --prometheus flag is set', async () => {
    const worker = makeWorkerInfo({ id: 0, pid: 1234 });
    const apps = [makeAppStatus({ workers: [worker] })];

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: apps }),
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand(['test-app'], { prometheus: true });

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('bunpilot_cpu_percent');
    expect(allOutput).toContain('bunpilot_memory_rss_bytes');
    expect(allOutput).toContain('bunpilot_memory_heap_used_bytes');
    expect(allOutput).toContain('bunpilot_memory_heap_total_bytes');
    expect(allOutput).toContain('bunpilot_memory_external_bytes');
    expect(allOutput).toContain('bunpilot_restart_count');
    expect(allOutput).toContain('app="test-app"');
    expect(allOutput).toContain('worker="0"');
    expect(allOutput).toContain('pid="1234"');
  });

  test('prints "No metrics available" when apps array is empty', async () => {
    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: [] }),
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand([], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('No metrics available');
  });

  test('sends command without name when no positional argument', async () => {
    let capturedArgs: unknown;

    mockConnect({
      sendCommand: async (_cmd: unknown, args: unknown) => {
        capturedArgs = args;
        return { id: '1', ok: true, data: [] };
      },
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand([], {});

    expect(capturedArgs).toBeUndefined();
  });

  test('sends command with name when positional argument is given', async () => {
    let capturedArgs: unknown;

    mockConnect({
      sendCommand: async (_cmd: unknown, args: unknown) => {
        capturedArgs = args;
        return { id: '1', ok: true, data: [] };
      },
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand(['web'], {});

    expect(capturedArgs).toEqual({ name: 'web' });
  });

  test('prometheus output skips cpu line when worker has no cpu metrics', async () => {
    const worker = makeWorkerInfo({ id: 0, pid: 1234, cpu: null });
    const apps = [makeAppStatus({ workers: [worker] })];

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: apps }),
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand([], { prometheus: true });

    const allOutput = captured.logs.join('\n');
    expect(allOutput).not.toContain('bunpilot_cpu_percent');
    expect(allOutput).toContain('bunpilot_memory_rss_bytes');
  });

  test('prometheus output skips memory lines when worker has no memory', async () => {
    const worker = makeWorkerInfo({ id: 0, pid: 1234, memory: null });
    const apps = [makeAppStatus({ workers: [worker] })];

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: apps }),
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand([], { prometheus: true });

    const allOutput = captured.logs.join('\n');
    expect(allOutput).not.toContain('bunpilot_memory_rss_bytes');
    expect(allOutput).not.toContain('bunpilot_memory_heap_used_bytes');
    expect(allOutput).toContain('bunpilot_cpu_percent');
    expect(allOutput).toContain('bunpilot_restart_count');
  });

  test('table output shows dash for worker without metrics', async () => {
    const worker = makeWorkerInfo({ id: 0, pid: 1234, cpu: null, memory: null });
    const apps = [makeAppStatus({ workers: [worker] })];

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: apps }),
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand([], {});

    const allOutput = captured.logs.join('\n');
    // \u2014 is the em-dash used as placeholder
    expect(allOutput).toContain('\u2014');
  });

  test('prometheus output includes restart count for every worker', async () => {
    const w1 = makeWorkerInfo({ id: 0, pid: 100, restartCount: 3, cpu: null, memory: null });
    const w2 = makeWorkerInfo({ id: 1, pid: 101, restartCount: 7, cpu: null, memory: null });
    const apps = [makeAppStatus({ workers: [w1, w2] })];

    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: apps }),
    });

    const { metricsCommand } = await import('../../../src/cli/commands/metrics');

    captured = captureConsole();
    await metricsCommand([], { prometheus: true });

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('bunpilot_restart_count{app="test-app",worker="0",pid="100"} 3');
    expect(allOutput).toContain('bunpilot_restart_count{app="test-app",worker="1",pid="101"} 7');
  });
});

// ---------------------------------------------------------------------------
// daemonCommand
// ---------------------------------------------------------------------------

describe('daemonCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('exits with error when no sub-command is given', async () => {
    const { daemonCommand } = await import('../../../src/cli/commands/daemon');

    captured = captureConsole();

    try {
      await daemonCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
    const errOutput = captured.errors.join('\n');
    expect(errOutput).toContain('Usage');
    expect(errOutput).toContain('start');
    expect(errOutput).toContain('stop');
    expect(errOutput).toContain('status');
  });

  test('exits with error for invalid sub-command', async () => {
    const { daemonCommand } = await import('../../../src/cli/commands/daemon');

    captured = captureConsole();

    try {
      await daemonCommand(['invalid'], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
    const errOutput = captured.errors.join('\n');
    expect(errOutput).toContain('Usage');
  });

  test('daemon status reports "not running" when no PID file exists', async () => {
    mock.module('../../../src/daemon/pid', () => ({
      readPidFile: () => null,
      isProcessRunning: () => false,
      writePidFile: () => {},
      removePidFile: () => {},
    }));

    const { daemonCommand } = await import('../../../src/cli/commands/daemon');

    captured = captureConsole();
    await daemonCommand(['status'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('not running');
    expect(allOutput).toContain('no PID file');
  });

  test('daemon status reports "running" when process is alive', async () => {
    mock.module('../../../src/daemon/pid', () => ({
      readPidFile: () => 12345,
      isProcessRunning: (pid: number) => pid === 12345,
      writePidFile: () => {},
      removePidFile: () => {},
    }));

    const { daemonCommand } = await import('../../../src/cli/commands/daemon');

    captured = captureConsole();
    await daemonCommand(['status'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('running');
    expect(allOutput).toContain('12345');
  });

  test('daemon status reports stale PID when process is not alive', async () => {
    mock.module('../../../src/daemon/pid', () => ({
      readPidFile: () => 99999,
      isProcessRunning: () => false,
      writePidFile: () => {},
      removePidFile: () => {},
    }));

    const { daemonCommand } = await import('../../../src/cli/commands/daemon');

    captured = captureConsole();
    await daemonCommand(['status'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('not running');
    expect(allOutput).toContain('stale');
    expect(allOutput).toContain('99999');
  });

  test('daemon stop reports success when stopDaemon returns true', async () => {
    mock.module('../../../src/daemon/daemonize', () => ({
      daemonize: () => {},
      stopDaemon: async () => true,
    }));

    const { daemonCommand } = await import('../../../src/cli/commands/daemon');

    captured = captureConsole();
    await daemonCommand(['stop'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('Daemon stopped');
  });

  test('daemon stop exits with error when stopDaemon returns false', async () => {
    mock.module('../../../src/daemon/daemonize', () => ({
      daemonize: () => {},
      stopDaemon: async () => false,
    }));

    const { daemonCommand } = await import('../../../src/cli/commands/daemon');

    captured = captureConsole();

    try {
      await daemonCommand(['stop'], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
    const errOutput = captured.errors.join('\n');
    expect(errOutput).toContain('Failed to stop daemon');
  });

  test('daemon start warns if already running', async () => {
    mock.module('../../../src/daemon/pid', () => ({
      readPidFile: () => 12345,
      isProcessRunning: () => true,
      writePidFile: () => {},
      removePidFile: () => {},
    }));
    mock.module('../../../src/daemon/daemonize', () => ({
      daemonize: () => {},
      stopDaemon: async () => true,
    }));

    const { daemonCommand } = await import('../../../src/cli/commands/daemon');

    captured = captureConsole();
    await daemonCommand(['start'], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('already running');
    expect(allOutput).toContain('12345');
  });

  test('daemon start calls daemonize when not already running', async () => {
    let daemonizeCalled = false;

    mock.module('../../../src/daemon/pid', () => ({
      readPidFile: () => null,
      isProcessRunning: () => false,
      writePidFile: () => {},
      removePidFile: () => {},
    }));
    mock.module('../../../src/daemon/daemonize', () => ({
      daemonize: () => {
        daemonizeCalled = true;
        // daemonize normally calls process.exit(0), simulate that
        process.exit(0);
      },
      stopDaemon: async () => true,
    }));

    const { daemonCommand } = await import('../../../src/cli/commands/daemon');

    captured = captureConsole();

    try {
      await daemonCommand(['start'], {});
    } catch {
      // process.exit throws
    }

    expect(daemonizeCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// pingCommand
// ---------------------------------------------------------------------------

describe('pingCommand', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('prints pong with response time on success', async () => {
    mockConnect({
      sendCommand: async () => ({ id: '1', ok: true, data: { pong: true } }),
    });

    const { pingCommand } = await import('../../../src/cli/commands/ping');

    captured = captureConsole();
    await pingCommand([], {});

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('pong');
    expect(allOutput).toContain('ms');
  });

  test('prints error and exits when daemon is not responding', async () => {
    mockConnect({
      sendCommand: async () => {
        throw new Error('daemon is not running');
      },
    });

    const { pingCommand } = await import('../../../src/cli/commands/ping');

    captured = captureConsole();

    try {
      await pingCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
    const errOutput = captured.errors.join('\n');
    expect(errOutput).toContain('Daemon is not responding');
  });

  test('response time is a valid number', async () => {
    mockConnect({
      sendCommand: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return { id: '1', ok: true, data: { pong: true } };
      },
    });

    const { pingCommand } = await import('../../../src/cli/commands/ping');

    captured = captureConsole();
    await pingCommand([], {});

    const allOutput = captured.logs.join('\n');
    const match = allOutput.match(/(\d+\.\d+)\s*ms/);
    expect(match).toBeTruthy();
    const elapsed = parseFloat(match![1]);
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });

  test('sends "ping" command to daemon', async () => {
    let capturedCmd: unknown;

    mockConnect({
      sendCommand: async (cmd: unknown) => {
        capturedCmd = cmd;
        return { id: '1', ok: true, data: { pong: true } };
      },
    });

    const { pingCommand } = await import('../../../src/cli/commands/ping');

    captured = captureConsole();
    await pingCommand([], {});

    expect(capturedCmd).toBe('ping');
  });
});

// ---------------------------------------------------------------------------
// initCommand
// ---------------------------------------------------------------------------

describe('initCommand', () => {
  let captured: ConsoleCapture;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'bunpilot-init-test-'));
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('creates bunpilot.config.ts in cwd when file does not exist', async () => {
    const { initCommand } = await import('../../../src/cli/commands/init');

    const origCwd = process.cwd;
    process.cwd = () => tempDir;

    captured = captureConsole();

    try {
      await initCommand([], {});
    } finally {
      process.cwd = origCwd;
    }

    const configPath = join(tempDir, 'bunpilot.config.ts');
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain("name: 'my-app'");
    expect(content).toContain("script: './src/index.ts'");
    expect(content).toContain("instances: 'max'");
    expect(content).toContain('port: 3000');
    expect(content).toContain("NODE_ENV: 'production'");
    expect(content).toContain('export default config');

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('Created');
    expect(allOutput).toContain('bunpilot.config.ts');
  });

  test('warns and does not overwrite when config file already exists', async () => {
    const configPath = join(tempDir, 'bunpilot.config.ts');
    const existingContent = 'existing config content';
    await Bun.write(configPath, existingContent);

    const { initCommand } = await import('../../../src/cli/commands/init');

    const origCwd = process.cwd;
    process.cwd = () => tempDir;

    captured = captureConsole();

    try {
      await initCommand([], {});
    } finally {
      process.cwd = origCwd;
    }

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toBe(existingContent);

    const allOutput = captured.logs.join('\n');
    expect(allOutput).toContain('already exists');
  });

  test('generated config imports BunpilotConfig type', async () => {
    const { initCommand } = await import('../../../src/cli/commands/init');

    const origCwd = process.cwd;
    process.cwd = () => tempDir;

    captured = captureConsole();

    try {
      await initCommand([], {});
    } finally {
      process.cwd = origCwd;
    }

    const configPath = join(tempDir, 'bunpilot.config.ts');
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain("import type { BunpilotConfig } from 'bunpilot'");
  });

  test('generated config has valid TypeScript structure', async () => {
    const { initCommand } = await import('../../../src/cli/commands/init');

    const origCwd = process.cwd;
    process.cwd = () => tempDir;

    captured = captureConsole();

    try {
      await initCommand([], {});
    } finally {
      process.cwd = origCwd;
    }

    const configPath = join(tempDir, 'bunpilot.config.ts');
    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain('const config: BunpilotConfig');
    expect(content).toContain('apps: [');
    expect(content).toContain('env: {');
  });

  test('generated config contains an apps array with at least one entry', async () => {
    const { initCommand } = await import('../../../src/cli/commands/init');

    const origCwd = process.cwd;
    process.cwd = () => tempDir;

    captured = captureConsole();

    try {
      await initCommand([], {});
    } finally {
      process.cwd = origCwd;
    }

    const configPath = join(tempDir, 'bunpilot.config.ts');
    const content = readFileSync(configPath, 'utf-8');
    // Should have the apps array with an object inside
    expect(content).toContain('apps: [');
    expect(content).toContain('{');
    expect(content).toContain('}');
  });
});

// ---------------------------------------------------------------------------
// requireArg behavior (tested through command invocations)
// ---------------------------------------------------------------------------

describe('requireArg behavior via commands', () => {
  let captured: ConsoleCapture;

  beforeEach(() => {
    captureExit();
  });

  afterEach(() => {
    if (captured) captured.restore();
    restoreExit();
  });

  test('statusCommand calls process.exit(1) when no args are provided', async () => {
    mockConnect({
      requireArg: (args: string[], label: string) => {
        const value = args[0];
        if (!value) {
          console.error(`Missing required argument: <${label}>`);
          process.exit(1);
        }
        return value;
      },
    });

    const { statusCommand } = await import('../../../src/cli/commands/status');

    captured = captureConsole();

    try {
      await statusCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
    const errOutput = captured.errors.join('\n');
    expect(errOutput).toContain('Missing required argument');
    expect(errOutput).toContain('app-name');
  });

  test('logsCommand calls process.exit(1) when no args are provided', async () => {
    mockConnect({
      requireArg: (args: string[], label: string) => {
        const value = args[0];
        if (!value) {
          console.error(`Missing required argument: <${label}>`);
          process.exit(1);
        }
        return value;
      },
    });

    const { logsCommand } = await import('../../../src/cli/commands/logs');

    captured = captureConsole();

    try {
      await logsCommand([], {});
    } catch {
      // process.exit throws
    }

    expect(exitCalls).toContain(1);
    const errOutput = captured.errors.join('\n');
    expect(errOutput).toContain('Missing required argument');
    expect(errOutput).toContain('app-name');
  });
});
