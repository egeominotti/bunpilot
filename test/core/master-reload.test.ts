// ---------------------------------------------------------------------------
// bunpilot – MasterOrchestrator reload integration (real ReloadHandler)
// ---------------------------------------------------------------------------
//
// Unlike master.test.ts (which stubs reloadHandler), this exercises the REAL
// rolling-restart drain/spawn flow so we catch the H1 ghost-worker leak: every
// reload must leave exactly `instances` workers, never accumulate stale ones.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'reload-app',
    script: 'app.ts',
    instances: 2,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 150,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    // Fast rolling restart with no inter-batch delay for quick tests.
    clustering: {
      enabled: true,
      strategy: 'proxy',
      rollingRestart: { batchSize: 1, batchDelay: 0 },
    },
    ...overrides,
  };
}

/** Replace only the I/O-bound collaborators; keep the real reloadHandler. */
function stub(master: MasterOrchestrator): void {
  const m = master as any;
  let nextPid = 6000;

  m.autoReady = true;
  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (workerId: number, message: { type: 'ready' }) => void,
    ): SpawnedWorker {
      const spawned = {
        proc: {} as any,
        pid: nextPid++,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      };
      if (m.autoReady) queueMicrotask(() => onMessage(workerId, { type: 'ready' }));
      return spawned;
    },
    async killWorker() {
      return 'exited' as const;
    },
    isRunning() {
      return false;
    },
  };

  m.logManager = { pipeOutput() {}, closeAll() {} };

  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor() {},
    stopHeartbeatMonitor() {},
    onHeartbeat() {},
    stopAll() {},
    getWorkerPort: () => 40001,
    isHeartbeatStale: () => false,
  };

  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {},
  });

  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

describe('MasterOrchestrator reload (real ReloadHandler)', () => {
  let master: MasterOrchestrator;

  beforeEach(() => {
    master = new MasterOrchestrator();
    stub(master);
  });

  test('reload does not accumulate ghost workers (H1)', async () => {
    const config = makeConfig({ name: 'h1-app', instances: 2 });
    await master.startApp(config);

    const m = master as any;
    const managed = m.apps.get('h1-app');
    expect(managed.workers.length).toBe(2);

    // Replacements report ready, then each old worker is retired.
    await master.reloadApp('h1-app');
    expect(managed.workers.length).toBe(2);

    const idsAfterFirst = managed.workers
      .map((w: any) => w.id)
      .sort((a: number, b: number) => a - b);
    // Old workers (0,1) must be gone, replaced by fresh ids (2,3).
    expect(idsAfterFirst).toEqual([2, 3]);

    await master.reloadApp('h1-app');
    expect(managed.workers.length).toBe(2);
    const idsAfterSecond = managed.workers
      .map((w: any) => w.id)
      .sort((a: number, b: number) => a - b);
    expect(idsAfterSecond).toEqual([4, 5]);
  });

  test('drained workers release their per-worker monitor state (H1)', async () => {
    const config = makeConfig({ name: 'h1-timers', instances: 1 });
    await master.startApp(config);

    const m = master as any;
    const managed = m.apps.get('h1-timers');

    await master.reloadApp('h1-timers');

    // Only the live replacement keeps a stable timer; the drained worker's
    // timer must have been cleared (not leaked).
    expect(managed.stableTimers.size).toBe(managed.workers.length);
  });

  test('aborted reload retires the crashed replacement and keeps the old worker (H3/H1)', async () => {
    const config = makeConfig({ name: 'h3-app', instances: 1, readyTimeout: 1_000 });
    await master.startApp(config);

    const m = master as any;
    const managed = m.apps.get('h3-app');
    // The original worker is serving; it must survive a failed reload.
    managed.workers[0].state = 'online';
    m.autoReady = false;

    const reloadPromise = master.reloadApp('h3-app');

    // After the replacement spawns, force it to crash before it comes online.
    await new Promise((r) => setTimeout(r, 50));
    const replacement = managed.workers.find((w: any) => w.id !== 0);
    expect(replacement).toBeDefined();
    replacement.state = 'crashed';

    await expect(reloadPromise).rejects.toThrow('reload aborted');

    // Old worker preserved, crashed replacement retired — no ghost left behind.
    expect(managed.workers.length).toBe(1);
    expect(managed.workers[0].id).toBe(0);
    expect(managed.workers[0].state).toBe('online');
    expect(managed.workers.some((w: any) => w.id === replacement.id)).toBe(false);
  });

  test('synchronous replacement spawn failure rolls back the partial worker and port', async () => {
    const config = makeConfig({ name: 'spawn-failure-app', instances: 1, port: 31_111 });
    await master.startApp(config);

    const m = master as any;
    const managed = m.apps.get('spawn-failure-app');
    const originalWorkerId = managed.workers[0].id;
    const originalPortCount = managed.workerPorts.size;
    m.processManager.spawnWorker = () => {
      throw new Error('synthetic spawn failure');
    };

    await expect(master.reloadApp('spawn-failure-app')).rejects.toThrow('synthetic spawn failure');

    expect(managed.workers.map((worker: any) => worker.id)).toEqual([originalWorkerId]);
    expect(managed.workerPorts.size).toBe(originalPortCount);
  });

  test('a failed old-worker drain rolls back its online replacement', async () => {
    const config = makeConfig({ name: 'drain-failure-app', instances: 1 });
    await master.startApp(config);

    const m = master as any;
    const managed = m.apps.get('drain-failure-app');
    managed.workers[0].state = 'online';
    const originalPid = managed.spawned.get(0).pid;
    m.processManager.killWorker = async (pid: number) => {
      if (pid === originalPid) throw new Error('synthetic drain failure');
      return 'exited' as const;
    };
    m.processManager.isRunning = (pid: number) => pid === originalPid;

    await expect(master.reloadApp('drain-failure-app')).rejects.toThrow('synthetic drain failure');

    expect(managed.workers.map((worker: any) => worker.id)).toEqual([0]);
    expect(managed.workers[0].state).toBe('online');
    expect(managed.spawned.size).toBe(1);
  });
});
