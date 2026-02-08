// ---------------------------------------------------------------------------
// bunpilot – Control Handlers unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createCommandHandlers,
  type CommandContext,
  type Handler,
} from '../../src/control/handlers';

// ---------------------------------------------------------------------------
// Mock CommandContext factory
// ---------------------------------------------------------------------------

function createMockContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    listApps: () => [],
    getApp: () => undefined,
    startApp: async () => {},
    stopApp: async () => {},
    restartApp: async () => {},
    reloadApp: async () => {},
    deleteApp: async () => {},
    getMetrics: () => ({}),
    getLogs: () => [],
    dumpState: () => ({}),
    shutdown: async () => {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_COMMANDS = [
  'list',
  'status',
  'start',
  'stop',
  'restart',
  'reload',
  'delete',
  'metrics',
  'logs',
  'ping',
  'dump',
  'kill-daemon',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCommandHandlers', () => {
  let handlers: Map<string, Handler>;
  let ctx: CommandContext;

  beforeEach(() => {
    ctx = createMockContext();
    handlers = createCommandHandlers(ctx);
  });

  // -----------------------------------------------------------------------
  // Factory structure
  // -----------------------------------------------------------------------

  test('returns a Map', () => {
    expect(handlers).toBeInstanceOf(Map);
  });

  test('contains all expected commands', () => {
    for (const cmd of ALL_COMMANDS) {
      expect(handlers.has(cmd)).toBe(true);
    }
  });

  test('every handler is a function', () => {
    for (const [, handler] of handlers) {
      expect(typeof handler).toBe('function');
    }
  });

  test('contains exactly the expected number of commands', () => {
    expect(handlers.size).toBe(ALL_COMMANDS.length);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('handler: list', () => {
  test('returns ok with empty apps array', async () => {
    const ctx = createMockContext({ listApps: () => [] });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('list')!;

    const res = await handler({});
    expect(res.ok).toBe(true);
    expect(res.data).toEqual([]);
  });

  test('returns ok with populated apps array', async () => {
    const fakeApps = [
      { name: 'web', status: 'running' as const, workers: [], config: {} as any, startedAt: Date.now() },
      { name: 'api', status: 'stopped' as const, workers: [], config: {} as any, startedAt: null },
    ];
    const ctx = createMockContext({ listApps: () => fakeApps });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('list')!;

    const res = await handler({});
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(fakeApps);
    expect((res.data as any[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

describe('handler: status', () => {
  test('returns error when name is missing', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('status')!;

    const res = await handler({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing required argument: name');
  });

  test('returns error when name is empty string', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('status')!;

    const res = await handler({ name: '' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing required argument: name');
  });

  test('returns error when name is not a string', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('status')!;

    const res = await handler({ name: 123 });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing required argument: name');
  });

  test('returns error when app is not found', async () => {
    const ctx = createMockContext({ getApp: () => undefined });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('status')!;

    const res = await handler({ name: 'nonexistent' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('App not found: nonexistent');
  });

  test('returns ok with app status when found', async () => {
    const fakeApp = {
      name: 'web',
      status: 'running' as const,
      workers: [],
      config: {} as any,
      startedAt: Date.now(),
    };
    const ctx = createMockContext({ getApp: (name) => (name === 'web' ? fakeApp : undefined) });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('status')!;

    const res = await handler({ name: 'web' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(fakeApp);
  });
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe('handler: start', () => {
  test('returns error when name is missing', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('start')!;

    const res = await handler({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing required argument: name');
  });

  test('returns ok with started action on success', async () => {
    const ctx = createMockContext({ startApp: async () => {} });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('start')!;

    const res = await handler({ name: 'web' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ name: 'web', action: 'started' });
  });

  test('returns error when startApp throws', async () => {
    const ctx = createMockContext({
      startApp: async () => {
        throw new Error('App already running');
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('start')!;

    const res = await handler({ name: 'web' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('App already running');
  });

  test('handles non-Error throw from startApp', async () => {
    const ctx = createMockContext({
      startApp: async () => {
        throw 'string error';
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('start')!;

    const res = await handler({ name: 'web' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('string error');
  });
});

// ---------------------------------------------------------------------------
// stop
// ---------------------------------------------------------------------------

describe('handler: stop', () => {
  test('returns error when name is missing', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('stop')!;

    const res = await handler({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing required argument: name');
  });

  test('returns ok with stopped action on success', async () => {
    const ctx = createMockContext({ stopApp: async () => {} });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('stop')!;

    const res = await handler({ name: 'api' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ name: 'api', action: 'stopped' });
  });

  test('returns error when stopApp throws', async () => {
    const ctx = createMockContext({
      stopApp: async () => {
        throw new Error('App not found');
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('stop')!;

    const res = await handler({ name: 'ghost' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('App not found');
  });
});

// ---------------------------------------------------------------------------
// restart
// ---------------------------------------------------------------------------

describe('handler: restart', () => {
  test('returns error when name is missing', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('restart')!;

    const res = await handler({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing required argument: name');
  });

  test('returns ok with restarted action on success', async () => {
    const ctx = createMockContext({ restartApp: async () => {} });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('restart')!;

    const res = await handler({ name: 'web' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ name: 'web', action: 'restarted' });
  });

  test('returns error when restartApp throws', async () => {
    const ctx = createMockContext({
      restartApp: async () => {
        throw new Error('restart failed');
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('restart')!;

    const res = await handler({ name: 'web' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('restart failed');
  });
});

// ---------------------------------------------------------------------------
// reload
// ---------------------------------------------------------------------------

describe('handler: reload', () => {
  test('returns error when name is missing', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('reload')!;

    const res = await handler({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing required argument: name');
  });

  test('returns ok with reloaded action on success', async () => {
    const ctx = createMockContext({ reloadApp: async () => {} });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('reload')!;

    const res = await handler({ name: 'web' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ name: 'web', action: 'reloaded' });
  });

  test('returns error when reloadApp throws', async () => {
    const ctx = createMockContext({
      reloadApp: async () => {
        throw new Error('reload failed');
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('reload')!;

    const res = await handler({ name: 'web' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('reload failed');
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('handler: delete', () => {
  test('returns error when name is missing', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('delete')!;

    const res = await handler({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing required argument: name');
  });

  test('returns ok with deleted action on success', async () => {
    const ctx = createMockContext({ deleteApp: async () => {} });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('delete')!;

    const res = await handler({ name: 'old-app' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ name: 'old-app', action: 'deleted' });
  });

  test('returns error when deleteApp throws', async () => {
    const ctx = createMockContext({
      deleteApp: async () => {
        throw new Error('cannot delete');
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('delete')!;

    const res = await handler({ name: 'old-app' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('cannot delete');
  });
});

// ---------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------

describe('handler: metrics', () => {
  test('returns ok with empty metrics', async () => {
    const ctx = createMockContext({ getMetrics: () => ({}) });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('metrics')!;

    const res = await handler({});
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({});
  });

  test('returns ok with populated metrics', async () => {
    const fakeMetrics = { web: { cpu: 12.5, memory: 1024 } };
    const ctx = createMockContext({ getMetrics: () => fakeMetrics });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('metrics')!;

    const res = await handler({});
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(fakeMetrics);
  });
});

// ---------------------------------------------------------------------------
// logs
// ---------------------------------------------------------------------------

describe('handler: logs', () => {
  test('returns error when name is missing', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('logs')!;

    const res = await handler({});
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Missing required argument: name');
  });

  test('returns ok with log lines', async () => {
    const logLines = ['line 1', 'line 2', 'line 3'];
    const ctx = createMockContext({ getLogs: () => logLines });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('logs')!;

    const res = await handler({ name: 'web' });
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(logLines);
  });

  test('passes lines argument when provided as number', async () => {
    let receivedLines: number | undefined;
    const ctx = createMockContext({
      getLogs: (_name, lines) => {
        receivedLines = lines;
        return [];
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('logs')!;

    await handler({ name: 'web', lines: 50 });
    expect(receivedLines).toBe(50);
  });

  test('does not pass lines argument when it is not a number', async () => {
    let receivedLines: number | undefined = 999;
    const ctx = createMockContext({
      getLogs: (_name, lines) => {
        receivedLines = lines;
        return [];
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('logs')!;

    await handler({ name: 'web', lines: 'all' });
    expect(receivedLines).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ping
// ---------------------------------------------------------------------------

describe('handler: ping', () => {
  test('returns ok with pong and timestamp', async () => {
    const ctx = createMockContext();
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('ping')!;

    const before = Date.now();
    const res = await handler({});
    const after = Date.now();

    expect(res.ok).toBe(true);
    const data = res.data as { pong: boolean; ts: number };
    expect(data.pong).toBe(true);
    expect(data.ts).toBeGreaterThanOrEqual(before);
    expect(data.ts).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// dump
// ---------------------------------------------------------------------------

describe('handler: dump', () => {
  test('returns ok with empty state', async () => {
    const ctx = createMockContext({ dumpState: () => ({}) });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('dump')!;

    const res = await handler({});
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({});
  });

  test('returns ok with populated state', async () => {
    const fakeState = { apps: ['web', 'api'], workers: 4 };
    const ctx = createMockContext({ dumpState: () => fakeState });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('dump')!;

    const res = await handler({});
    expect(res.ok).toBe(true);
    expect(res.data).toEqual(fakeState);
  });
});

// ---------------------------------------------------------------------------
// kill-daemon
// ---------------------------------------------------------------------------

describe('handler: kill-daemon', () => {
  test('returns ok with shutting-down action', async () => {
    let shutdownCalled = false;
    const ctx = createMockContext({
      shutdown: async () => {
        shutdownCalled = true;
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('kill-daemon')!;

    const res = await handler({});
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ action: 'shutting-down' });
  });

  test('schedules shutdown asynchronously (does not block response)', async () => {
    let shutdownCalled = false;
    const ctx = createMockContext({
      shutdown: async () => {
        shutdownCalled = true;
      },
    });
    const handlers = createCommandHandlers(ctx);
    const handler = handlers.get('kill-daemon')!;

    const res = await handler({});
    // Shutdown is scheduled with setTimeout(100), not called yet
    expect(res.ok).toBe(true);
    expect(shutdownCalled).toBe(false);

    // Wait for the setTimeout to fire
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(shutdownCalled).toBe(true);
  });
});
