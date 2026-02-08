// ---------------------------------------------------------------------------
// bunpilot – ReloadHandler Unit Tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import { ReloadHandler, type ReloadContext } from '../../src/core/reload-handler';
import { WorkerLifecycle } from '../../src/core/lifecycle';
import type { ProcessManager } from '../../src/core/process-manager';
import type { AppConfig, WorkerInfo } from '../../src/config/types';

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
    readyTimeout: 200,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helper: create a WorkerInfo
// ---------------------------------------------------------------------------

function makeWorker(id: number, state: WorkerInfo['state'] = 'online'): WorkerInfo {
  return {
    id,
    pid: 1000 + id,
    state,
    startedAt: Date.now(),
    readyAt: state === 'online' ? Date.now() : null,
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
// Tests
// ---------------------------------------------------------------------------

describe('ReloadHandler', () => {
  let reloadHandler: ReloadHandler;

  beforeEach(() => {
    reloadHandler = new ReloadHandler();
  });

  // -------------------------------------------------------------------------
  // rollingRestart basic behaviour
  // -------------------------------------------------------------------------

  describe('rollingRestart', () => {
    test('spawns replacement workers and drains old ones', async () => {
      const w1 = makeWorker(1);
      const w2 = makeWorker(2);
      const workers = [w1, w2];
      const config = makeConfig({ readyTimeout: 100 });

      const spawnedIds: number[] = [];
      const drainedIds: number[] = [];

      const ctx: ReloadContext = {
        config,
        workers,
        processManager: {} as ProcessManager,
        lifecycle: new WorkerLifecycle(),
        spawnAndTrack: (_cfg, workerId) => {
          spawnedIds.push(workerId);
          // Return a replacement worker that is already "online"
          return makeWorker(workerId + 100, 'online');
        },
        drainAndStop: async (worker) => {
          drainedIds.push(worker.id);
          worker.state = 'stopped';
        },
      };

      await reloadHandler.rollingRestart(ctx);

      // Both old workers should have been drained
      expect(drainedIds).toContain(1);
      expect(drainedIds).toContain(2);

      // Both should have had replacements spawned
      expect(spawnedIds).toContain(1);
      expect(spawnedIds).toContain(2);
    });

    test('uses default batchSize of 1 when not configured', async () => {
      const w1 = makeWorker(1);
      const w2 = makeWorker(2);
      const workers = [w1, w2];
      const config = makeConfig({ readyTimeout: 100 });
      // No clustering config -> defaults to batchSize=1

      const spawnOrder: number[] = [];
      const drainOrder: number[] = [];

      const ctx: ReloadContext = {
        config,
        workers,
        processManager: {} as ProcessManager,
        lifecycle: new WorkerLifecycle(),
        spawnAndTrack: (_cfg, workerId) => {
          spawnOrder.push(workerId);
          return makeWorker(workerId + 100, 'online');
        },
        drainAndStop: async (worker) => {
          drainOrder.push(worker.id);
          worker.state = 'stopped';
        },
      };

      await reloadHandler.rollingRestart(ctx);

      // With batchSize=1, worker 1 is spawned+drained before worker 2
      expect(spawnOrder).toEqual([1, 2]);
      expect(drainOrder).toEqual([1, 2]);
    });

    test('uses configured batchSize to group workers', async () => {
      const w1 = makeWorker(1);
      const w2 = makeWorker(2);
      const w3 = makeWorker(3);
      const w4 = makeWorker(4);
      const workers = [w1, w2, w3, w4];
      const config = makeConfig({
        readyTimeout: 100,
        clustering: {
          enabled: true,
          strategy: 'auto',
          rollingRestart: { batchSize: 2, batchDelay: 0 },
        },
      });

      // Track the order of spawn and drain calls
      const spawnCalls: number[] = [];
      const drainCalls: number[] = [];

      const ctx: ReloadContext = {
        config,
        workers,
        processManager: {} as ProcessManager,
        lifecycle: new WorkerLifecycle(),
        spawnAndTrack: (_cfg, workerId) => {
          spawnCalls.push(workerId);
          return makeWorker(workerId + 100, 'online');
        },
        drainAndStop: async (worker) => {
          drainCalls.push(worker.id);
          worker.state = 'stopped';
        },
      };

      await reloadHandler.rollingRestart(ctx);

      // All 4 workers should have been spawned and drained
      expect(spawnCalls).toEqual([1, 2, 3, 4]);
      expect(drainCalls).toEqual([1, 2, 3, 4]);
    });

    test('waits for replacement workers to be online before draining old ones', async () => {
      const w1 = makeWorker(1);
      const workers = [w1];
      const config = makeConfig({ readyTimeout: 500 });

      let replacementReady = false;
      let drainedBeforeReady = false;

      const ctx: ReloadContext = {
        config,
        workers,
        processManager: {} as ProcessManager,
        lifecycle: new WorkerLifecycle(),
        spawnAndTrack: (_cfg, workerId) => {
          const replacement = makeWorker(workerId + 100, 'starting');
          // Simulate the worker becoming online after a short delay
          setTimeout(() => {
            replacement.state = 'online';
            replacementReady = true;
          }, 50);
          return replacement;
        },
        drainAndStop: async (worker) => {
          if (!replacementReady) {
            drainedBeforeReady = true;
          }
          worker.state = 'stopped';
        },
      };

      await reloadHandler.rollingRestart(ctx);

      // The old worker should have been drained after the replacement was ready
      expect(replacementReady).toBe(true);
      expect(drainedBeforeReady).toBe(false);
    });

    test('proceeds after readyTimeout even if replacement is not online', async () => {
      const w1 = makeWorker(1);
      const workers = [w1];
      const config = makeConfig({ readyTimeout: 100 });

      let drained = false;

      const ctx: ReloadContext = {
        config,
        workers,
        processManager: {} as ProcessManager,
        lifecycle: new WorkerLifecycle(),
        spawnAndTrack: (_cfg, workerId) => {
          // Return a replacement that never becomes online
          return makeWorker(workerId + 100, 'starting');
        },
        drainAndStop: async (worker) => {
          drained = true;
          worker.state = 'stopped';
        },
      };

      await reloadHandler.rollingRestart(ctx);

      // Should have drained even though replacement is still starting
      expect(drained).toBe(true);
    });

    test('handles empty workers list', async () => {
      const config = makeConfig({ readyTimeout: 100 });
      let spawnCalled = false;
      let drainCalled = false;

      const ctx: ReloadContext = {
        config,
        workers: [],
        processManager: {} as ProcessManager,
        lifecycle: new WorkerLifecycle(),
        spawnAndTrack: () => {
          spawnCalled = true;
          return makeWorker(1, 'online');
        },
        drainAndStop: async () => {
          drainCalled = true;
        },
      };

      await reloadHandler.rollingRestart(ctx);

      expect(spawnCalled).toBe(false);
      expect(drainCalled).toBe(false);
    });

    test('applies batchDelay between batches but not after the last', async () => {
      const w1 = makeWorker(1);
      const w2 = makeWorker(2);
      const workers = [w1, w2];
      const config = makeConfig({
        readyTimeout: 50,
        clustering: {
          enabled: true,
          strategy: 'auto',
          rollingRestart: { batchSize: 1, batchDelay: 100 },
        },
      });

      const timestamps: number[] = [];

      const ctx: ReloadContext = {
        config,
        workers,
        processManager: {} as ProcessManager,
        lifecycle: new WorkerLifecycle(),
        spawnAndTrack: (_cfg, workerId) => {
          timestamps.push(Date.now());
          return makeWorker(workerId + 100, 'online');
        },
        drainAndStop: async (worker) => {
          worker.state = 'stopped';
        },
      };

      const start = Date.now();
      await reloadHandler.rollingRestart(ctx);
      const elapsed = Date.now() - start;

      // With batchDelay=100 and 2 batches, there should be ~100ms delay between them
      // but not after the last, so total should be roughly >=100ms
      expect(elapsed).toBeGreaterThanOrEqual(80); // allow some timing slack
    });

    test('handles single worker', async () => {
      const w1 = makeWorker(1);
      const workers = [w1];
      const config = makeConfig({ readyTimeout: 100 });

      let spawned = false;
      let drained = false;

      const ctx: ReloadContext = {
        config,
        workers,
        processManager: {} as ProcessManager,
        lifecycle: new WorkerLifecycle(),
        spawnAndTrack: (_cfg, workerId) => {
          spawned = true;
          return makeWorker(workerId + 100, 'online');
        },
        drainAndStop: async (worker) => {
          drained = true;
          worker.state = 'stopped';
        },
      };

      await reloadHandler.rollingRestart(ctx);

      expect(spawned).toBe(true);
      expect(drained).toBe(true);
    });

    test('drains all workers in a batch concurrently', async () => {
      const w1 = makeWorker(1);
      const w2 = makeWorker(2);
      const workers = [w1, w2];
      const config = makeConfig({
        readyTimeout: 100,
        clustering: {
          enabled: true,
          strategy: 'auto',
          rollingRestart: { batchSize: 2, batchDelay: 0 },
        },
      });

      const drainStarts: number[] = [];
      const drainEnds: number[] = [];

      const ctx: ReloadContext = {
        config,
        workers,
        processManager: {} as ProcessManager,
        lifecycle: new WorkerLifecycle(),
        spawnAndTrack: (_cfg, workerId) => {
          return makeWorker(workerId + 100, 'online');
        },
        drainAndStop: async (worker) => {
          drainStarts.push(Date.now());
          // Simulate some async drain time
          await new Promise((resolve) => setTimeout(resolve, 50));
          worker.state = 'stopped';
          drainEnds.push(Date.now());
        },
      };

      await reloadHandler.rollingRestart(ctx);

      // Both drains should have started at roughly the same time (concurrent via Promise.all)
      expect(drainStarts.length).toBe(2);
      const timeDiff = Math.abs(drainStarts[0] - drainStarts[1]);
      // They should start within a few ms of each other (concurrent), not 50ms apart (sequential)
      expect(timeDiff).toBeLessThan(30);
    });
  });
});
