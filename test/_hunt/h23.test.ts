// ---------------------------------------------------------------------------
// H23 — reload must not retire a worker whose restart is still in flight.
// ---------------------------------------------------------------------------
//
// Invariant (RL-4/RL-2): once `retireWorker` has spliced a WorkerInfo out of
// `managed.workers`, released its port and dropped its launch token, no code
// may ever spawn a process for that WorkerInfo again.
//
// Race: a crashed worker's backoff timer fires and `restartWorker` parks in
// `await sleep(PORT_RELEASE_DELAY)` (500 ms). A reload that lands inside that
// window spawns a replacement, drains + retires the old worker, and resolves.
// The parked `restartWorker` then resumes and calls `launchWorker` for the
// retired worker: it re-registers a launch token, spawns a process and arms a
// ready timeout. Because the worker is no longer in `managed.workers`, its
// 'ready' IPC is dropped by `findWorker() === undefined`, so it never leaves
// 'starting', the ready timeout fires, `scheduleRestart` runs again (the
// re-entrancy guard was cleared by retireWorker) and the orphan respawns
// itself forever — invisible to `list`, never killed by `stopAllWorkers`.
//
// Property-based: a seeded PRNG picks several reload offsets inside the
// port-release window; the invariant is asserted after every scenario.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic 32-bit PRNG (mulberry32) so failures are reproducible. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeConfig(name: string, port: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    // A configured port is what makes restartWorker park in
    // `await sleep(PORT_RELEASE_DELAY)` — the window this race needs.
    port,
    instances: 1,
    maxRestarts: 10,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 50,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 200,
    backoff: { initial: 10, multiplier: 1, max: 10 },
    clustering: {
      enabled: false,
      strategy: 'proxy',
      rollingRestart: { batchSize: 1, batchDelay: 0 },
    },
  } as AppConfig;
}

interface Harness {
  spawnLog: number[];
  exits: Map<number, (wid: number, code: number | null, sig: string | null) => void>;
}

/** Stub only the I/O collaborators; keep the real reload/launch/worker logic. */
function stub(master: MasterOrchestrator): Harness {
  const m = master as any;
  let nextPid = 9000;
  const spawnLog: number[] = [];
  const exits = new Map<number, (wid: number, code: number | null, sig: string | null) => void>();

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (workerId: number, message: { type: 'ready' }) => void,
      onExit: (workerId: number, code: number | null, sig: string | null) => void,
    ): SpawnedWorker {
      spawnLog.push(workerId);
      exits.set(workerId, onExit);
      const spawned = {
        proc: {} as any,
        pid: nextPid++,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      };
      queueMicrotask(() => onMessage(workerId, { type: 'ready' }));
      return spawned;
    },
    async killWorker() {
      return 'exited' as const;
    },
    isRunning() {
      return false;
    },
  };

  m.logManager = { pipeOutput() {}, closeAll() {}, closeApp() {}, closeWorker() {} };

  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor() {},
    stopHeartbeatMonitor() {},
    onHeartbeat() {},
    stopAll() {},
    getWorkerPort: () => undefined,
    isHeartbeatStale: () => false,
  };

  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {},
  });

  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);

  return { spawnLog, exits };
}

async function runScenario(offset: number, port: number): Promise<void> {
  const master = new MasterOrchestrator();
  const { spawnLog, exits } = stub(master);
  const name = `h23-app-${port}`;
  const m = master as any;

  await master.startApp(makeConfig(name, port));
  const managed = m.apps.get(name);

  try {
    // Worker 0 is online; crash it. The backoff timer (10 ms) fires and
    // restartWorker parks in `await sleep(PORT_RELEASE_DELAY)` (500 ms).
    await sleep(25);
    expect(managed.workers[0].state).toBe('online');
    exits.get(0)?.(0, 1, null);

    // Land the reload inside the port-release window.
    await sleep(offset);
    await master.reloadApp(name);

    // Old worker 0 has been retired by the reload.
    expect(managed.workers.some((w: any) => w.id === 0)).toBe(false);

    // Give the parked restartWorker time to resume (and, if the bug is
    // present, to re-spawn the retired worker a few more times). Sample the
    // invariant continuously: the orphan briefly disappears from
    // `managed.spawned` while its own restart is parked, so a single snapshot
    // can miss it.
    const orphansEverSeen = new Set<number>();
    for (let i = 0; i < 32; i++) {
      await sleep(50);
      for (const id of managed.spawned.keys()) {
        if (!managed.workers.some((w: any) => w.id === id)) orphansEverSeen.add(id);
      }
    }

    const orphans = [...orphansEverSeen].sort((a, b) => a - b);
    const zeroSpawns = spawnLog.filter((id) => id === 0).length;

    expect({ offset, orphans, zeroSpawns }).toEqual({ offset, orphans: [], zeroSpawns: 1 });
  } finally {
    // Stop the respawn loop and every timer it armed before leaving the test.
    managed.stopping = true;
    for (const t of managed.readyTimers.values()) clearTimeout(t);
    managed.readyTimers.clear();
    for (const t of managed.stableTimers.values()) clearTimeout(t);
    managed.stableTimers.clear();
    m.workerHandler.cleanupApp(managed);
    await master.shutdown('SIGTERM').catch(() => undefined);
    managed.stopping = true;
  }
}

test('reload never retires a worker whose restart is still in flight (RL-4)', async () => {
  const SEED = 0x1723;
  const rand = prng(SEED);
  const offsets = [40, 150, 300];

  for (const base of offsets) {
    // Deterministic jitter kept well inside the 500 ms port-release window.
    const offset = base + Math.floor(rand() * 20);
    const port = 31_300 + base;
    try {
      await runScenario(offset, port);
    } catch (err) {
      console.error(`[h23] FAILING offset=${offset}ms (seed=${SEED}, base=${base})`);
      throw err;
    }
  }
}, 25_000);
