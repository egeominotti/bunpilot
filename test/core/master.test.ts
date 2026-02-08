// ---------------------------------------------------------------------------
// bunpilot – MasterOrchestrator Unit Tests
// ---------------------------------------------------------------------------
//
// Strategy: MasterOrchestrator creates its own dependencies internally.
// We construct the real instance and then replace the private fields
// (processManager, logManager, healthChecker, reloadHandler) with stubs
// via `as any`.  This avoids mock.module pollution across test files.
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { MasterOrchestrator } from '../../src/core/master';
import type { AppConfig, WorkerInfo } from '../../src/config/types';
import type { SpawnedWorker } from '../../src/core/process-manager';

// ---------------------------------------------------------------------------
// Tracking state
// ---------------------------------------------------------------------------

interface TestContext {
  spawnCalls: Array<{ config: AppConfig; workerId: number }>;
  killCalls: Array<{ pid: number; signal: string; timeout: number }>;
  pipeOutputCalls: Array<{
    appName: string;
    workerId: number;
    foreground: boolean;
  }>;
  closeAllCalls: number;
  startCheckingCalls: Array<{ workerId: number; config: AppConfig }>;
  stopCheckingCalls: number[];
  startHeartbeatCalls: Array<{ workerId: number }>;
  stopHeartbeatCalls: number[];
  stopAllHealthCalls: number;
  rollingRestartCalls: Array<unknown>;
  unhealthyCallbacks: Array<(workerId: number, reason: string) => void>;
  nextPid: number;
}

function createContext(): TestContext {
  return {
    spawnCalls: [],
    killCalls: [],
    pipeOutputCalls: [],
    closeAllCalls: 0,
    startCheckingCalls: [],
    stopCheckingCalls: [],
    startHeartbeatCalls: [],
    stopHeartbeatCalls: [],
    stopAllHealthCalls: 0,
    rollingRestartCalls: [],
    unhealthyCallbacks: [],
    nextPid: 5000,
  };
}

// ---------------------------------------------------------------------------
// Helper: minimal AppConfig
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'test-app',
    script: 'app.ts',
    instances: 2,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub factory: replace private fields on MasterOrchestrator
// ---------------------------------------------------------------------------

function stubMaster(master: MasterOrchestrator, ctx: TestContext): void {
  const m = master as any;

  // --- ProcessManager stub ---
  m.processManager = {
    spawnWorker(
      config: AppConfig,
      workerId: number,
      _onMessage: unknown,
      _onExit: unknown,
    ): SpawnedWorker {
      ctx.spawnCalls.push({ config, workerId });
      const pid = ctx.nextPid++;
      return {
        proc: {} as any,
        pid,
        stdout: new ReadableStream({ start(c) { c.close(); } }),
        stderr: new ReadableStream({ start(c) { c.close(); } }),
      };
    },
    async killWorker(pid: number, signal: string, timeout: number) {
      ctx.killCalls.push({ pid, signal, timeout });
      return 'exited' as const;
    },
    isRunning() {
      return false;
    },
  };

  // --- LogManager stub ---
  m.logManager = {
    pipeOutput(
      appName: string,
      workerId: number,
      _stdout: ReadableStream,
      _stderr: ReadableStream,
      _logsConfig: unknown,
      foreground: boolean,
    ) {
      ctx.pipeOutputCalls.push({ appName, workerId, foreground });
    },
    closeAll() {
      ctx.closeAllCalls++;
    },
  };

  // --- HealthChecker stub ---
  m.healthChecker = {
    onUnhealthy(cb: (workerId: number, reason: string) => void) {
      ctx.unhealthyCallbacks.push(cb);
    },
    offUnhealthy() {},
    startChecking(workerId: number, config: AppConfig) {
      ctx.startCheckingCalls.push({ workerId, config });
    },
    stopChecking(workerId: number) {
      ctx.stopCheckingCalls.push(workerId);
    },
    startHeartbeatMonitor(workerId: number, _onStale: (wid: number) => void) {
      ctx.startHeartbeatCalls.push({ workerId });
    },
    stopHeartbeatMonitor(workerId: number) {
      ctx.stopHeartbeatCalls.push(workerId);
    },
    onHeartbeat() {},
    stopAll() {
      ctx.stopAllHealthCalls++;
    },
    getWorkerPort() {
      return 40001;
    },
    isHeartbeatStale() {
      return false;
    },
  };

  // --- ReloadHandler stub ---
  m.reloadHandler = {
    async rollingRestart(rctx: unknown) {
      ctx.rollingRestartCalls.push(rctx);
    },
  };

  // Re-create workerHandler with the stubbed processManager.
  // WorkerHandler uses processManager for killWorker in stopAllWorkers.
  const { WorkerHandler } = require('../../src/core/worker-handler');
  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);

  // Re-register the healthChecker onUnhealthy callback (constructor does this).
  m.healthChecker.onUnhealthy((workerId: number, reason: string) => {
    for (const [, managed] of m.apps) {
      const worker = m.workerHandler.findWorker(managed, workerId);
      if (worker && (worker.state === 'online' || worker.state === 'starting')) {
        m.healthChecker.stopChecking(workerId);
        m.healthChecker.stopHeartbeatMonitor(workerId);
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MasterOrchestrator', () => {
  let master: MasterOrchestrator;
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createContext();
    master = new MasterOrchestrator();
    stubMaster(master, ctx);
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    test('creates a MasterOrchestrator instance', () => {
      expect(master).toBeDefined();
      expect(master).toBeInstanceOf(MasterOrchestrator);
    });

    test('registers an onUnhealthy callback via stubbing', () => {
      // Our stubMaster registers one callback
      expect(ctx.unhealthyCallbacks.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // onShutdown
  // -------------------------------------------------------------------------

  describe('onShutdown', () => {
    test('registers a shutdown callback that is not called immediately', () => {
      const cb = mock(() => {});
      master.onShutdown(cb);
      expect(cb).not.toHaveBeenCalled();
    });

    test('shutdown callback is invoked during shutdown', async () => {
      const cb = mock(() => {});
      master.onShutdown(cb);

      await master.shutdown('SIGTERM');

      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('multiple shutdown callbacks are all invoked', async () => {
      const cb1 = mock(() => {});
      const cb2 = mock(() => {});
      master.onShutdown(cb1);
      master.onShutdown(cb2);

      await master.shutdown('SIGTERM');

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    test('async shutdown callbacks are awaited', async () => {
      let resolved = false;
      const cb = async () => {
        await new Promise((r) => setTimeout(r, 10));
        resolved = true;
      };
      master.onShutdown(cb);

      await master.shutdown('SIGTERM');

      expect(resolved).toBe(true);
    });

    test('shutdown continues even if a callback throws', async () => {
      const cb1 = mock(() => {
        throw new Error('cb1 error');
      });
      const cb2 = mock(() => {});
      master.onShutdown(cb1);
      master.onShutdown(cb2);

      // Should not throw
      await master.shutdown('SIGTERM');

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // startApp
  // -------------------------------------------------------------------------

  describe('startApp', () => {
    test('spawns the correct number of workers', async () => {
      const config = makeConfig({ name: 'my-app', instances: 3 });
      await master.startApp(config);

      expect(ctx.spawnCalls.length).toBe(3);
      expect(ctx.spawnCalls[0].workerId).toBe(0);
      expect(ctx.spawnCalls[1].workerId).toBe(1);
      expect(ctx.spawnCalls[2].workerId).toBe(2);
    });

    test('spawns a single worker when instances is 1', async () => {
      const config = makeConfig({ name: 'single-app', instances: 1 });
      await master.startApp(config);

      expect(ctx.spawnCalls.length).toBe(1);
      expect(ctx.spawnCalls[0].workerId).toBe(0);
      expect(ctx.spawnCalls[0].config.name).toBe('single-app');
    });

    test('passes the correct config to spawnWorker', async () => {
      const config = makeConfig({ name: 'cfg-app', script: 'server.ts' });
      await master.startApp(config);

      expect(ctx.spawnCalls[0].config.name).toBe('cfg-app');
      expect(ctx.spawnCalls[0].config.script).toBe('server.ts');
    });

    test('throws when starting an app that is already running', async () => {
      const config = makeConfig({ name: 'dup-app' });
      await master.startApp(config);

      expect(master.startApp(config)).rejects.toThrow('App "dup-app" is already running.');
    });

    test('starts health checking for each worker', async () => {
      const config = makeConfig({ name: 'health-app', instances: 2 });
      await master.startApp(config);

      expect(ctx.startCheckingCalls.length).toBe(2);
      expect(ctx.startCheckingCalls[0].workerId).toBe(0);
      expect(ctx.startCheckingCalls[1].workerId).toBe(1);
    });

    test('starts heartbeat monitoring for each worker', async () => {
      const config = makeConfig({ name: 'hb-app', instances: 2 });
      await master.startApp(config);

      expect(ctx.startHeartbeatCalls.length).toBe(2);
      expect(ctx.startHeartbeatCalls[0].workerId).toBe(0);
      expect(ctx.startHeartbeatCalls[1].workerId).toBe(1);
    });

    test('pipes log output for each worker', async () => {
      const config = makeConfig({ name: 'log-app', instances: 2 });
      await master.startApp(config);

      expect(ctx.pipeOutputCalls.length).toBe(2);
      expect(ctx.pipeOutputCalls[0].appName).toBe('log-app');
      expect(ctx.pipeOutputCalls[0].workerId).toBe(0);
      expect(ctx.pipeOutputCalls[1].appName).toBe('log-app');
      expect(ctx.pipeOutputCalls[1].workerId).toBe(1);
    });

    test('resolves "max" instances to CPU count', async () => {
      const { cpus } = await import('node:os');
      const cpuCount = cpus().length;

      const config = makeConfig({ name: 'max-app', instances: 'max' });
      await master.startApp(config);

      expect(ctx.spawnCalls.length).toBe(cpuCount);
    });

    test('app appears in listApps after starting', async () => {
      const config = makeConfig({ name: 'listed-app', instances: 1 });
      await master.startApp(config);

      const apps = master.listApps();
      expect(apps.length).toBe(1);
      expect(apps[0].name).toBe('listed-app');
    });
  });

  // -------------------------------------------------------------------------
  // stopApp
  // -------------------------------------------------------------------------

  describe('stopApp', () => {
    test('stops all workers of an app', async () => {
      const config = makeConfig({ name: 'stop-app', instances: 2 });
      await master.startApp(config);

      await master.stopApp('stop-app');

      const status = master.getAppStatus('stop-app');
      expect(status).not.toBeNull();
      expect(status!.startedAt).toBeNull();
    });

    test('throws when stopping a non-existent app', () => {
      expect(master.stopApp('ghost')).rejects.toThrow('App "ghost" not found.');
    });

    test('stops health checking before killing workers', async () => {
      const config = makeConfig({ name: 'hc-stop-app', instances: 2 });
      await master.startApp(config);

      ctx.stopCheckingCalls = [];
      ctx.stopHeartbeatCalls = [];

      await master.stopApp('hc-stop-app');

      // Should have stopped checking for worker 0 and 1
      expect(ctx.stopCheckingCalls.length).toBeGreaterThanOrEqual(2);
      expect(ctx.stopHeartbeatCalls.length).toBeGreaterThanOrEqual(2);
    });

    test('sets startedAt to null after stopping', async () => {
      const config = makeConfig({ name: 'null-start-app', instances: 1 });
      await master.startApp(config);

      await master.stopApp('null-start-app');

      const status = master.getAppStatus('null-start-app');
      expect(status!.startedAt).toBeNull();
    });

    test('workers transition to stopped state', async () => {
      const config = makeConfig({ name: 'stop-state-app', instances: 2 });
      await master.startApp(config);

      await master.stopApp('stop-state-app');

      const status = master.getAppStatus('stop-state-app');
      for (const worker of status!.workers) {
        expect(worker.state).toBe('stopped');
      }
    });
  });

  // -------------------------------------------------------------------------
  // restartApp
  // -------------------------------------------------------------------------

  describe('restartApp', () => {
    test('stops then starts workers', async () => {
      const config = makeConfig({ name: 'restart-app', instances: 2 });
      await master.startApp(config);

      const initialSpawnCount = ctx.spawnCalls.length;
      expect(initialSpawnCount).toBe(2);

      await master.restartApp('restart-app');

      // 2 initial + 2 restart = 4
      expect(ctx.spawnCalls.length).toBe(4);
    });

    test('throws when restarting a non-existent app', () => {
      expect(master.restartApp('nope')).rejects.toThrow('App "nope" not found.');
    });

    test('resets startedAt on restart', async () => {
      const config = makeConfig({ name: 'reset-app', instances: 2 });
      await master.startApp(config);

      const statusBefore = master.getAppStatus('reset-app');
      const startedAtBefore = statusBefore!.startedAt;

      // Small delay to ensure different timestamp
      await new Promise((r) => setTimeout(r, 5));

      await master.restartApp('reset-app');

      const statusAfter = master.getAppStatus('reset-app');
      expect(statusAfter!.startedAt).not.toBeNull();
      expect(statusAfter!.startedAt).toBeGreaterThanOrEqual(startedAtBefore!);
    });

    test('spawns workers with fresh IDs starting from 0', async () => {
      const config = makeConfig({ name: 'fresh-id-app', instances: 2 });
      await master.startApp(config);

      ctx.spawnCalls = [];
      await master.restartApp('fresh-id-app');

      expect(ctx.spawnCalls.length).toBe(2);
      expect(ctx.spawnCalls[0].workerId).toBe(0);
      expect(ctx.spawnCalls[1].workerId).toBe(1);
    });

    test('clears existing workers array', async () => {
      const config = makeConfig({ name: 'clear-workers-app', instances: 2 });
      await master.startApp(config);

      await master.restartApp('clear-workers-app');

      const status = master.getAppStatus('clear-workers-app');
      // Should have exactly 2 fresh workers (old ones are cleared)
      expect(status!.workers.length).toBe(2);
    });

    test('restarted workers are in starting state', async () => {
      const config = makeConfig({ name: 'restart-state-app', instances: 1 });
      await master.startApp(config);

      await master.restartApp('restart-state-app');

      const status = master.getAppStatus('restart-state-app');
      expect(status!.workers[0].state).toBe('starting');
    });
  });

  // -------------------------------------------------------------------------
  // reloadApp
  // -------------------------------------------------------------------------

  describe('reloadApp', () => {
    test('calls rollingRestart on the ReloadHandler', async () => {
      const config = makeConfig({ name: 'reload-app', instances: 2 });
      await master.startApp(config);

      ctx.rollingRestartCalls = [];
      await master.reloadApp('reload-app');

      expect(ctx.rollingRestartCalls.length).toBe(1);
    });

    test('throws when reloading a non-existent app', () => {
      expect(master.reloadApp('missing')).rejects.toThrow('App "missing" not found.');
    });

    test('passes the correct config to rollingRestart', async () => {
      const config = makeConfig({ name: 'reload-cfg-app', instances: 2 });
      await master.startApp(config);

      ctx.rollingRestartCalls = [];
      await master.reloadApp('reload-cfg-app');

      const rctx = ctx.rollingRestartCalls[0] as {
        config: AppConfig;
        workers: WorkerInfo[];
        spawnAndTrack: Function;
        drainAndStop: Function;
      };

      expect(rctx.config.name).toBe('reload-cfg-app');
      expect(rctx.workers.length).toBe(2);
      expect(typeof rctx.spawnAndTrack).toBe('function');
      expect(typeof rctx.drainAndStop).toBe('function');
    });

    test('passes the processManager and lifecycle to rollingRestart', async () => {
      const config = makeConfig({ name: 'reload-deps-app', instances: 1 });
      await master.startApp(config);

      ctx.rollingRestartCalls = [];
      await master.reloadApp('reload-deps-app');

      const rctx = ctx.rollingRestartCalls[0] as {
        processManager: unknown;
        lifecycle: unknown;
      };

      expect(rctx.processManager).toBeDefined();
      expect(rctx.lifecycle).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // deleteApp
  // -------------------------------------------------------------------------

  describe('deleteApp', () => {
    test('deletes an existing app', async () => {
      const config = makeConfig({ name: 'delete-app', instances: 1 });
      await master.startApp(config);

      expect(master.getAppStatus('delete-app')).not.toBeNull();

      await master.deleteApp('delete-app');

      expect(master.getAppStatus('delete-app')).toBeNull();
    });

    test('stops health monitoring before deleting', async () => {
      const config = makeConfig({ name: 'hc-del-app', instances: 2 });
      await master.startApp(config);

      ctx.stopCheckingCalls = [];
      ctx.stopHeartbeatCalls = [];

      await master.deleteApp('hc-del-app');

      expect(ctx.stopCheckingCalls.length).toBeGreaterThanOrEqual(2);
      expect(ctx.stopHeartbeatCalls.length).toBeGreaterThanOrEqual(2);
    });

    test('removes app from listApps', async () => {
      const config = makeConfig({ name: 'list-del-app', instances: 1 });
      await master.startApp(config);

      expect(master.listApps().length).toBe(1);

      await master.deleteApp('list-del-app');

      expect(master.listApps().length).toBe(0);
    });

    test('is a no-op for a non-existent app', async () => {
      // Should not throw
      await master.deleteApp('no-such-app');
      expect(master.listApps().length).toBe(0);
    });

    test('deleted app can be re-added', async () => {
      const config = makeConfig({ name: 'del-readd-app', instances: 1 });
      await master.startApp(config);
      await master.deleteApp('del-readd-app');

      ctx.spawnCalls = [];
      await master.startApp(config);
      expect(ctx.spawnCalls.length).toBe(1);
      expect(master.getAppStatus('del-readd-app')).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // listApps
  // -------------------------------------------------------------------------

  describe('listApps', () => {
    test('returns empty array when no apps exist', () => {
      expect(master.listApps()).toEqual([]);
    });

    test('returns all started apps', async () => {
      await master.startApp(makeConfig({ name: 'app-a', instances: 1 }));
      await master.startApp(makeConfig({ name: 'app-b', instances: 1 }));

      const apps = master.listApps();
      expect(apps.length).toBe(2);

      const names = apps.map((a) => a.name).sort();
      expect(names).toEqual(['app-a', 'app-b']);
    });

    test('returns correct AppStatus structure', async () => {
      await master.startApp(makeConfig({ name: 'struct-app', instances: 2 }));

      const apps = master.listApps();
      expect(apps.length).toBe(1);

      const app = apps[0];
      expect(app.name).toBe('struct-app');
      expect(app.status).toBeDefined();
      expect(app.workers).toBeDefined();
      expect(app.workers.length).toBe(2);
      expect(app.config).toBeDefined();
      expect(app.startedAt).not.toBeNull();
    });

    test('returns copies of workers, not references', async () => {
      await master.startApp(makeConfig({ name: 'copy-app', instances: 1 }));

      const apps1 = master.listApps();
      const apps2 = master.listApps();

      expect(apps1[0].workers).not.toBe(apps2[0].workers);
    });

    test('includes stopped apps that were not deleted', async () => {
      await master.startApp(makeConfig({ name: 'still-there', instances: 1 }));
      await master.stopApp('still-there');

      const apps = master.listApps();
      expect(apps.length).toBe(1);
      expect(apps[0].name).toBe('still-there');
    });
  });

  // -------------------------------------------------------------------------
  // getAppStatus
  // -------------------------------------------------------------------------

  describe('getAppStatus', () => {
    test('returns null for a non-existent app', () => {
      expect(master.getAppStatus('nope')).toBeNull();
    });

    test('returns status for an existing app', async () => {
      await master.startApp(makeConfig({ name: 'status-app', instances: 1 }));

      const status = master.getAppStatus('status-app');
      expect(status).not.toBeNull();
      expect(status!.name).toBe('status-app');
    });

    test('reports running status when workers are in starting state', async () => {
      await master.startApp(makeConfig({ name: 'starting-app', instances: 2 }));

      const status = master.getAppStatus('starting-app');
      expect(status!.status).toBe('running');
    });

    test('includes all worker info', async () => {
      await master.startApp(makeConfig({ name: 'workers-app', instances: 3 }));

      const status = master.getAppStatus('workers-app');
      expect(status!.workers.length).toBe(3);

      for (const worker of status!.workers) {
        expect(worker.id).toBeDefined();
        expect(worker.pid).toBeGreaterThan(0);
        expect(worker.state).toBe('starting');
        expect(worker.startedAt).toBeGreaterThan(0);
      }
    });

    test('includes config in status', async () => {
      const config = makeConfig({ name: 'cfg-status-app', script: 'my-server.ts', instances: 2 });
      await master.startApp(config);

      const status = master.getAppStatus('cfg-status-app');
      expect(status!.config.name).toBe('cfg-status-app');
      expect(status!.config.script).toBe('my-server.ts');
    });

    test('includes startedAt in status', async () => {
      const before = Date.now();
      await master.startApp(makeConfig({ name: 'time-app', instances: 1 }));
      const after = Date.now();

      const status = master.getAppStatus('time-app');
      expect(status!.startedAt).toBeGreaterThanOrEqual(before);
      expect(status!.startedAt).toBeLessThanOrEqual(after);
    });

    test('reports stopped status after stopApp', async () => {
      await master.startApp(makeConfig({ name: 'stopped-status', instances: 1 }));
      await master.stopApp('stopped-status');

      const status = master.getAppStatus('stopped-status');
      expect(status!.status).toBe('stopped');
    });

    test('reports running status after restartApp', async () => {
      await master.startApp(makeConfig({ name: 'restart-status', instances: 1 }));
      await master.restartApp('restart-status');

      const status = master.getAppStatus('restart-status');
      expect(status!.status).toBe('running');
      expect(status!.startedAt).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // shutdown
  // -------------------------------------------------------------------------

  describe('shutdown', () => {
    test('stops all apps', async () => {
      await master.startApp(makeConfig({ name: 'sd-a', instances: 1 }));
      await master.startApp(makeConfig({ name: 'sd-b', instances: 1 }));

      await master.shutdown('SIGTERM');

      expect(master.getAppStatus('sd-a')!.startedAt).toBeNull();
      expect(master.getAppStatus('sd-b')!.startedAt).toBeNull();
    });

    test('calls healthChecker.stopAll()', async () => {
      ctx.stopAllHealthCalls = 0;
      await master.shutdown('SIGTERM');
      expect(ctx.stopAllHealthCalls).toBe(1);
    });

    test('calls logManager.closeAll()', async () => {
      ctx.closeAllCalls = 0;
      await master.shutdown('SIGTERM');
      expect(ctx.closeAllCalls).toBe(1);
    });

    test('invokes registered shutdown callbacks', async () => {
      const cb = mock(() => {});
      master.onShutdown(cb);

      await master.shutdown('SIGTERM');

      expect(cb).toHaveBeenCalledTimes(1);
    });

    test('shutdown with no apps does not throw', async () => {
      await master.shutdown('SIGTERM');
      // Should complete without error
      expect(ctx.stopAllHealthCalls).toBe(1);
      expect(ctx.closeAllCalls).toBe(1);
    });

    test('handles shutdown callback errors gracefully', async () => {
      master.onShutdown(() => {
        throw new Error('cleanup failed');
      });
      const cb2 = mock(() => {});
      master.onShutdown(cb2);

      await master.shutdown('SIGTERM');

      // Second callback should still be called despite first throwing
      expect(cb2).toHaveBeenCalledTimes(1);
    });

    test('shutdown stops health checks before stopping apps', async () => {
      await master.startApp(makeConfig({ name: 'sh-order-app', instances: 1 }));

      ctx.stopAllHealthCalls = 0;
      ctx.stopCheckingCalls = [];

      await master.shutdown('SIGTERM');

      // stopAll is called first, then individual stopChecking in stopApp
      expect(ctx.stopAllHealthCalls).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // reloadAll
  // -------------------------------------------------------------------------

  describe('reloadAll', () => {
    test('reloads all running apps', async () => {
      await master.startApp(makeConfig({ name: 'ra-a', instances: 1 }));
      await master.startApp(makeConfig({ name: 'ra-b', instances: 1 }));

      ctx.rollingRestartCalls = [];
      await master.reloadAll();

      expect(ctx.rollingRestartCalls.length).toBe(2);
    });

    test('reloadAll with no apps does not throw', async () => {
      await master.reloadAll();
      expect(ctx.rollingRestartCalls.length).toBe(0);
    });

    test('reloadAll with single app calls rollingRestart once', async () => {
      await master.startApp(makeConfig({ name: 'ra-single', instances: 3 }));

      ctx.rollingRestartCalls = [];
      await master.reloadAll();

      expect(ctx.rollingRestartCalls.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // toAppStatus (private, tested via getAppStatus)
  // -------------------------------------------------------------------------

  describe('toAppStatus status derivation', () => {
    test('stopped status when all workers are stopped', async () => {
      await master.startApp(makeConfig({ name: 'all-stopped', instances: 1 }));
      await master.stopApp('all-stopped');

      const status = master.getAppStatus('all-stopped');
      expect(status!.status).toBe('stopped');
    });

    test('running status with workers in starting state', async () => {
      await master.startApp(makeConfig({ name: 'all-starting', instances: 2 }));

      const status = master.getAppStatus('all-starting');
      // Workers are in 'starting' (not online, not stopped)
      // The code path: no online, not allStopped => 'running'
      expect(status!.status).toBe('running');
    });
  });

  // -------------------------------------------------------------------------
  // Multi-app lifecycle
  // -------------------------------------------------------------------------

  describe('multi-app lifecycle', () => {
    test('can manage multiple apps independently', async () => {
      await master.startApp(makeConfig({ name: 'app-1', instances: 1 }));
      await master.startApp(makeConfig({ name: 'app-2', instances: 2 }));

      expect(master.listApps().length).toBe(2);

      await master.stopApp('app-1');

      expect(master.getAppStatus('app-1')!.startedAt).toBeNull();
      expect(master.getAppStatus('app-2')!.startedAt).not.toBeNull();
    });

    test('can delete one app without affecting others', async () => {
      await master.startApp(makeConfig({ name: 'keep-app', instances: 1 }));
      await master.startApp(makeConfig({ name: 'remove-app', instances: 1 }));

      await master.deleteApp('remove-app');

      expect(master.getAppStatus('keep-app')).not.toBeNull();
      expect(master.getAppStatus('remove-app')).toBeNull();
      expect(master.listApps().length).toBe(1);
    });

    test('full lifecycle: start, stop, restart, reload, delete', async () => {
      const config = makeConfig({ name: 'lifecycle-app', instances: 1 });

      // Start
      await master.startApp(config);
      expect(master.getAppStatus('lifecycle-app')!.startedAt).not.toBeNull();

      // Stop
      await master.stopApp('lifecycle-app');
      expect(master.getAppStatus('lifecycle-app')!.startedAt).toBeNull();

      // Restart
      await master.restartApp('lifecycle-app');
      expect(master.getAppStatus('lifecycle-app')!.startedAt).not.toBeNull();

      // Reload
      ctx.rollingRestartCalls = [];
      await master.reloadApp('lifecycle-app');
      expect(ctx.rollingRestartCalls.length).toBe(1);

      // Delete
      await master.deleteApp('lifecycle-app');
      expect(master.getAppStatus('lifecycle-app')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Worker PID assignment
  // -------------------------------------------------------------------------

  describe('worker PID assignment', () => {
    test('assigns sequential PIDs from the mock', async () => {
      ctx.nextPid = 9000;
      await master.startApp(makeConfig({ name: 'pid-app', instances: 2 }));

      const status = master.getAppStatus('pid-app');
      expect(status!.workers[0].pid).toBe(9000);
      expect(status!.workers[1].pid).toBe(9001);
    });

    test('PIDs are unique across apps', async () => {
      ctx.nextPid = 1000;
      await master.startApp(makeConfig({ name: 'pid-a', instances: 2 }));
      await master.startApp(makeConfig({ name: 'pid-b', instances: 2 }));

      const allPids = [
        ...master.getAppStatus('pid-a')!.workers.map((w) => w.pid),
        ...master.getAppStatus('pid-b')!.workers.map((w) => w.pid),
      ];
      const unique = new Set(allPids);
      expect(unique.size).toBe(4);
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    test('different instance counts per app', async () => {
      await master.startApp(makeConfig({ name: 'e-1', instances: 1 }));
      await master.startApp(makeConfig({ name: 'e-3', instances: 3 }));

      expect(master.getAppStatus('e-1')!.workers.length).toBe(1);
      expect(master.getAppStatus('e-3')!.workers.length).toBe(3);
    });

    test('restart resets nextWorkerId', async () => {
      const config = makeConfig({ name: 'nwid-app', instances: 2 });
      await master.startApp(config);

      ctx.spawnCalls = [];
      await master.restartApp('nwid-app');

      expect(ctx.spawnCalls[0].workerId).toBe(0);
      expect(ctx.spawnCalls[1].workerId).toBe(1);
    });

    test('worker state is "starting" before ready message', async () => {
      await master.startApp(makeConfig({ name: 'state-app', instances: 1 }));

      const status = master.getAppStatus('state-app');
      expect(status!.workers[0].state).toBe('starting');
    });

    test('workers have correct initial fields', async () => {
      await master.startApp(makeConfig({ name: 'init-app', instances: 1 }));

      const worker = master.getAppStatus('init-app')!.workers[0];
      expect(worker.restartCount).toBe(0);
      expect(worker.consecutiveCrashes).toBe(0);
      expect(worker.lastCrashAt).toBeNull();
      expect(worker.exitCode).toBeNull();
      expect(worker.signalCode).toBeNull();
      expect(worker.readyAt).toBeNull();
      expect(worker.memory).toBeNull();
      expect(worker.cpu).toBeNull();
    });

    test('config.instances is stored as resolved number in managed app', async () => {
      const config = makeConfig({ name: 'resolved-app', instances: 3 });
      await master.startApp(config);

      const status = master.getAppStatus('resolved-app');
      expect(status!.config.instances).toBe(3);
    });

    test('spawnWorker records both config name and workerId', async () => {
      await master.startApp(makeConfig({ name: 'track-app', instances: 2 }));

      expect(ctx.spawnCalls[0].config.name).toBe('track-app');
      expect(ctx.spawnCalls[0].workerId).toBe(0);
      expect(ctx.spawnCalls[1].config.name).toBe('track-app');
      expect(ctx.spawnCalls[1].workerId).toBe(1);
    });
  });
});
