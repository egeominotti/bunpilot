// ---------------------------------------------------------------------------
// bunpilot – WorkerHandler Unit Tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { WorkerHandler, type ManagedApp } from '../../src/core/worker-handler';
import { WorkerLifecycle } from '../../src/core/lifecycle';
import { CrashRecovery } from '../../src/core/backoff';
import type { ProcessManager } from '../../src/core/process-manager';
import type { AppConfig, WorkerInfo, WorkerMessage } from '../../src/config/types';

// ---------------------------------------------------------------------------
// Helper: minimal AppConfig
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'test-app',
    script: 'app.ts',
    instances: 1,
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
// Helper: create a WorkerInfo
// ---------------------------------------------------------------------------

function makeWorker(id: number, state: WorkerInfo['state'] = 'spawning'): WorkerInfo {
  return {
    id,
    pid: 1000 + id,
    state,
    startedAt: Date.now(),
    readyAt: null,
    restartCount: 0,
    consecutiveCrashes: 0,
    lastCrashAt: null,
    exitCode: null,
    signalCode: null,
    memory: null,
    cpu: null,
  };
}

// ---------------------------------------------------------------------------
// Helper: create a ManagedApp
// ---------------------------------------------------------------------------

function makeManagedApp(
  workers: WorkerInfo[],
  configOverrides: Partial<AppConfig> = {},
): ManagedApp {
  return {
    config: makeConfig(configOverrides),
    workers,
    spawned: new Map(),
    startedAt: Date.now(),
    stableTimers: new Map(),
    nextWorkerId: workers.length,
  };
}

// ---------------------------------------------------------------------------
// Mock ProcessManager
// ---------------------------------------------------------------------------

function mockProcessManager(): ProcessManager {
  return {
    spawnWorker: () => {
      throw new Error('spawnWorker not mocked');
    },
    killWorker: async () => 'exited' as const,
    isRunning: () => false,
  } as unknown as ProcessManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerHandler', () => {
  let lifecycle: WorkerLifecycle;
  let crashRecovery: CrashRecovery;
  let pm: ProcessManager;
  let handler: WorkerHandler;

  beforeEach(() => {
    lifecycle = new WorkerLifecycle();
    crashRecovery = new CrashRecovery();
    pm = mockProcessManager();
    handler = new WorkerHandler(pm, crashRecovery, lifecycle);
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    test('creates a WorkerHandler instance', () => {
      expect(handler).toBeDefined();
      expect(handler).toBeInstanceOf(WorkerHandler);
    });
  });

  // -------------------------------------------------------------------------
  // transitionWorker
  // -------------------------------------------------------------------------

  describe('transitionWorker', () => {
    test('transitions worker for a valid state change', () => {
      const worker = makeWorker(1, 'spawning');
      handler.transitionWorker(worker, 'starting');
      expect(worker.state).toBe('starting');
    });

    test('does not transition for an invalid state change', () => {
      const worker = makeWorker(1, 'online');
      handler.transitionWorker(worker, 'spawning');
      // State should remain unchanged
      expect(worker.state).toBe('online');
    });

    test('transitions through multiple valid states', () => {
      const worker = makeWorker(1, 'spawning');
      handler.transitionWorker(worker, 'starting');
      expect(worker.state).toBe('starting');

      handler.transitionWorker(worker, 'online');
      expect(worker.state).toBe('online');

      handler.transitionWorker(worker, 'draining');
      expect(worker.state).toBe('draining');

      handler.transitionWorker(worker, 'stopping');
      expect(worker.state).toBe('stopping');

      handler.transitionWorker(worker, 'stopped');
      expect(worker.state).toBe('stopped');
    });

    test('can transition from crashed to spawning', () => {
      const worker = makeWorker(1, 'crashed');
      handler.transitionWorker(worker, 'spawning');
      expect(worker.state).toBe('spawning');
    });
  });

  // -------------------------------------------------------------------------
  // findWorker
  // -------------------------------------------------------------------------

  describe('findWorker', () => {
    test('finds a worker by ID', () => {
      const w1 = makeWorker(1);
      const w2 = makeWorker(2);
      const managed = makeManagedApp([w1, w2]);

      const found = handler.findWorker(managed, 2);
      expect(found).toBe(w2);
    });

    test('returns undefined for a non-existent worker', () => {
      const managed = makeManagedApp([makeWorker(1)]);
      const found = handler.findWorker(managed, 999);
      expect(found).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // handleMessage
  // -------------------------------------------------------------------------

  describe('handleMessage', () => {
    test('handles ready message — transitions to online and sets readyAt', () => {
      const worker = makeWorker(1, 'starting');
      const managed = makeManagedApp([worker]);

      const msg: WorkerMessage = { type: 'ready' };
      handler.handleMessage(managed, 1, msg);

      expect(worker.state).toBe('online');
      expect(worker.readyAt).not.toBeNull();
      expect(worker.readyAt).toBeGreaterThan(0);
    });

    test('handles metrics message — stores memory and cpu data', () => {
      const worker = makeWorker(1, 'online');
      const managed = makeManagedApp([worker]);

      const msg: WorkerMessage = {
        type: 'metrics',
        payload: {
          memory: { rss: 100, heapTotal: 80, heapUsed: 60, external: 10 },
          cpu: { user: 500, system: 200 },
        },
      };
      handler.handleMessage(managed, 1, msg);

      expect(worker.memory).not.toBeNull();
      expect(worker.memory!.rss).toBe(100);
      expect(worker.memory!.heapTotal).toBe(80);
      expect(worker.memory!.heapUsed).toBe(60);
      expect(worker.memory!.external).toBe(10);
      expect(worker.memory!.timestamp).toBeGreaterThan(0);

      expect(worker.cpu).not.toBeNull();
      expect(worker.cpu!.user).toBe(500);
      expect(worker.cpu!.system).toBe(200);
      expect(worker.cpu!.percentage).toBe(0);
      expect(worker.cpu!.timestamp).toBeGreaterThan(0);
    });

    test('handles heartbeat message — no state change', () => {
      const worker = makeWorker(1, 'online');
      const managed = makeManagedApp([worker]);

      const msg: WorkerMessage = { type: 'heartbeat', uptime: 5000 };
      handler.handleMessage(managed, 1, msg);

      // No state change expected
      expect(worker.state).toBe('online');
    });

    test('handles custom message — no state change', () => {
      const worker = makeWorker(1, 'online');
      const managed = makeManagedApp([worker]);

      const msg: WorkerMessage = { type: 'custom', channel: 'test', data: { foo: 'bar' } };
      handler.handleMessage(managed, 1, msg);

      expect(worker.state).toBe('online');
    });

    test('ignores message for non-existent worker', () => {
      const managed = makeManagedApp([makeWorker(1)]);
      const msg: WorkerMessage = { type: 'ready' };

      // Should not throw
      handler.handleMessage(managed, 999, msg);
    });
  });

  // -------------------------------------------------------------------------
  // handleExit
  // -------------------------------------------------------------------------

  describe('handleExit', () => {
    test('transitions to stopped when worker state is stopping', () => {
      const worker = makeWorker(1, 'stopping');
      const managed = makeManagedApp([worker]);
      const onRestart = () => {};

      handler.handleExit(managed, 1, 0, null, onRestart);

      expect(worker.state).toBe('stopped');
      expect(worker.exitCode).toBe(0);
    });

    test('attempts transition to stopped when worker state is draining', () => {
      const worker = makeWorker(1, 'draining');
      const managed = makeManagedApp([worker]);
      const onRestart = () => {};

      handler.handleExit(managed, 1, 0, null, onRestart);

      // draining -> stopped is not a valid transition in TRANSITIONS map
      // (draining -> stopping is valid, but draining -> stopped is not).
      // The handleExit code tries to transition directly to 'stopped',
      // but transitionWorker silently ignores invalid transitions.
      // exitCode is still set before the transition attempt.
      expect(worker.exitCode).toBe(0);
      expect(worker.state).toBe('draining');
    });

    test('transitions to crashed on unexpected exit from online', () => {
      const worker = makeWorker(1, 'online');
      const managed = makeManagedApp([worker]);
      const restartCalls: number[] = [];
      const onRestart = (_m: ManagedApp, w: WorkerInfo) => restartCalls.push(w.id);

      handler.handleExit(managed, 1, 1, null, onRestart);

      expect(worker.state).toBe('crashed');
      expect(worker.exitCode).toBe(1);
      expect(worker.consecutiveCrashes).toBe(1);
      expect(worker.lastCrashAt).not.toBeNull();
    });

    test('transitions to errored when crash recovery gives up', () => {
      const worker = makeWorker(1, 'online');
      const managed = makeManagedApp([worker], { maxRestarts: 0 });
      const onRestart = () => {};

      handler.handleExit(managed, 1, 1, null, onRestart);

      // maxRestarts=0, so first crash in window (restartsInWindow=1 > 0) => give-up
      expect(worker.state).toBe('errored');
    });

    test('sets signalCode on exit', () => {
      const worker = makeWorker(1, 'stopping');
      const managed = makeManagedApp([worker]);
      const onRestart = () => {};

      handler.handleExit(managed, 1, null, 'SIGTERM', onRestart);

      expect(worker.signalCode).toBe('SIGTERM');
    });

    test('ignores exit for non-existent worker', () => {
      const managed = makeManagedApp([makeWorker(1)]);
      // Should not throw
      handler.handleExit(managed, 999, 0, null, () => {});
    });

    test('clears stable timer on exit', () => {
      const worker = makeWorker(1, 'stopping');
      const managed = makeManagedApp([worker]);
      // Set a fake stable timer
      const timer = setTimeout(() => {}, 10_000);
      managed.stableTimers.set(1, timer);

      handler.handleExit(managed, 1, 0, null, () => {});

      expect(managed.stableTimers.has(1)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // stopAllWorkers
  // -------------------------------------------------------------------------

  describe('stopAllWorkers', () => {
    test('stops all active workers', async () => {
      const w1 = makeWorker(1, 'online');
      const w2 = makeWorker(2, 'online');
      const managed = makeManagedApp([w1, w2]);

      // Add fake spawned entries
      managed.spawned.set(1, { proc: {} as any, pid: 1001, stdout: {} as any, stderr: {} as any });
      managed.spawned.set(2, { proc: {} as any, pid: 1002, stdout: {} as any, stderr: {} as any });

      await handler.stopAllWorkers(managed);

      expect(w1.state).toBe('stopped');
      expect(w2.state).toBe('stopped');
      expect(managed.spawned.size).toBe(0);
    });

    test('skips already stopped workers', async () => {
      const w1 = makeWorker(1, 'stopped');
      const w2 = makeWorker(2, 'online');
      const managed = makeManagedApp([w1, w2]);
      managed.spawned.set(2, { proc: {} as any, pid: 1002, stdout: {} as any, stderr: {} as any });

      await handler.stopAllWorkers(managed);

      expect(w1.state).toBe('stopped');
      expect(w2.state).toBe('stopped');
    });

    test('skips errored and crashed workers', async () => {
      const w1 = makeWorker(1, 'errored');
      const w2 = makeWorker(2, 'crashed');
      const w3 = makeWorker(3, 'online');
      const managed = makeManagedApp([w1, w2, w3]);
      managed.spawned.set(3, { proc: {} as any, pid: 1003, stdout: {} as any, stderr: {} as any });

      await handler.stopAllWorkers(managed);

      // errored and crashed remain as-is (force-set to stopped by the code)
      expect(w1.state).toBe('errored');
      expect(w2.state).toBe('crashed');
      expect(w3.state).toBe('stopped');
    });

    test('clears stable timers during stop', async () => {
      const w1 = makeWorker(1, 'online');
      const managed = makeManagedApp([w1]);
      managed.spawned.set(1, { proc: {} as any, pid: 1001, stdout: {} as any, stderr: {} as any });
      const timer = setTimeout(() => {}, 10_000);
      managed.stableTimers.set(1, timer);

      await handler.stopAllWorkers(managed);

      expect(managed.stableTimers.has(1)).toBe(false);
    });

    test('handles empty workers list gracefully', async () => {
      const managed = makeManagedApp([]);
      await handler.stopAllWorkers(managed);
      expect(managed.spawned.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // scheduleStableCheck
  // -------------------------------------------------------------------------

  describe('scheduleStableCheck', () => {
    afterEach(() => {
      // Clean up timers
    });

    test('adds a timer to stableTimers', () => {
      const worker = makeWorker(1, 'online');
      const managed = makeManagedApp([worker], { minUptime: 50_000 });

      handler.scheduleStableCheck(managed, worker);

      expect(managed.stableTimers.has(1)).toBe(true);
    });

    test('replaces an existing stable timer', () => {
      const worker = makeWorker(1, 'online');
      const managed = makeManagedApp([worker], { minUptime: 50_000 });

      handler.scheduleStableCheck(managed, worker);
      const firstTimer = managed.stableTimers.get(1);

      handler.scheduleStableCheck(managed, worker);
      const secondTimer = managed.stableTimers.get(1);

      // Timer reference should have been replaced
      expect(secondTimer).not.toBe(firstTimer);
    });

    test('resets consecutiveCrashes when worker is online after minUptime', async () => {
      const worker = makeWorker(1, 'online');
      worker.consecutiveCrashes = 3;
      const managed = makeManagedApp([worker], { minUptime: 10 });

      // Manually pre-seed crash recovery state
      crashRecovery.onWorkerCrash(1, managed.config);

      handler.scheduleStableCheck(managed, worker);

      // Wait for the minUptime timer to fire
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(worker.consecutiveCrashes).toBe(0);
    });

    test('does not reset crashes if worker state changed away from online', async () => {
      const worker = makeWorker(1, 'online');
      worker.consecutiveCrashes = 3;
      const managed = makeManagedApp([worker], { minUptime: 10 });

      handler.scheduleStableCheck(managed, worker);

      // Simulate state changing before timer fires
      worker.state = 'stopped';

      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should NOT have reset since state is no longer online
      expect(worker.consecutiveCrashes).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // clearStableTimer
  // -------------------------------------------------------------------------

  describe('clearStableTimer', () => {
    test('clears an existing timer', () => {
      const managed = makeManagedApp([]);
      const timer = setTimeout(() => {}, 10_000);
      managed.stableTimers.set(1, timer);

      handler.clearStableTimer(managed, 1);

      expect(managed.stableTimers.has(1)).toBe(false);
    });

    test('is a no-op for a non-existent timer', () => {
      const managed = makeManagedApp([]);
      // Should not throw
      handler.clearStableTimer(managed, 999);
      expect(managed.stableTimers.has(999)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // cleanupApp
  // -------------------------------------------------------------------------

  describe('cleanupApp', () => {
    test('clears all stable timers', () => {
      const w1 = makeWorker(1, 'online');
      const w2 = makeWorker(2, 'online');
      const managed = makeManagedApp([w1, w2]);

      managed.stableTimers.set(1, setTimeout(() => {}, 10_000));
      managed.stableTimers.set(2, setTimeout(() => {}, 10_000));

      handler.cleanupApp(managed);

      expect(managed.stableTimers.size).toBe(0);
    });

    test('resets crash recovery for all workers', () => {
      const w1 = makeWorker(1, 'online');
      const w2 = makeWorker(2, 'online');
      const managed = makeManagedApp([w1, w2]);

      // Build up some crash state
      crashRecovery.onWorkerCrash(1, managed.config);
      crashRecovery.onWorkerCrash(2, managed.config);

      expect(crashRecovery.getState(1)).toBeDefined();
      expect(crashRecovery.getState(2)).toBeDefined();

      handler.cleanupApp(managed);

      expect(crashRecovery.getState(1)).toBeUndefined();
      expect(crashRecovery.getState(2)).toBeUndefined();
    });

    test('handles empty workers list', () => {
      const managed = makeManagedApp([]);
      // Should not throw
      handler.cleanupApp(managed);
    });
  });

  // -------------------------------------------------------------------------
  // drainAndStopWorker
  // -------------------------------------------------------------------------

  describe('drainAndStopWorker', () => {
    test('drains and stops an online worker', async () => {
      const worker = makeWorker(1, 'online');
      const managed = makeManagedApp([worker]);
      managed.spawned.set(1, {
        proc: {} as any,
        pid: 1001,
        stdout: {} as any,
        stderr: {} as any,
      });

      await handler.drainAndStopWorker(managed, worker);

      expect(worker.state).toBe('stopped');
      expect(managed.spawned.has(1)).toBe(false);
    });

    test('does nothing if worker is not online', async () => {
      const worker = makeWorker(1, 'stopped');
      const managed = makeManagedApp([worker]);

      await handler.drainAndStopWorker(managed, worker);

      expect(worker.state).toBe('stopped');
    });

    test('handles worker with no spawned entry', async () => {
      const worker = makeWorker(1, 'online');
      const managed = makeManagedApp([worker]);
      // No spawned entry for worker 1

      await handler.drainAndStopWorker(managed, worker);

      expect(worker.state).toBe('stopped');
    });
  });
});
