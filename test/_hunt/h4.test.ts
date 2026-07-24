// ---------------------------------------------------------------------------
// H4 – retireWorker must be terminal
// ---------------------------------------------------------------------------
//
// Invariant under test (AGENTS.md "Non-negotiable invariants"):
//   "A stopped or deleting app must not be resurrected by health, heartbeat,
//    readiness, or crash timers." + "Public and internal ports are globally
//    collision-free ... and are released on stop, delete, rollback, and
//    retirement."
//
// Concretely: once `MasterOrchestrator.retireWorker` has spliced a WorkerInfo
// out of `managed.workers` (and released its port), NO further process may
// ever be spawned for that worker id.
//
// The failure mode: a reload whose replacement never reports ready arms TWO
// timers on the same `readyTimeout` — `launchWorker`'s readyTimer (which calls
// `scheduleRestart`) and `ReloadHandler.waitForReady`'s 100ms poll. The
// readyTimer wins, so `restartWorker` parks in `await sleep(PORT_RELEASE_DELAY)`
// while `reloadAppUnlocked`'s catch retires the very worker it holds. When the
// sleep resolves, `restartWorker` spawns a process for a retired worker — and
// that process arms a fresh readyTimer, so it repeats forever.
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic PRNG so a failure is always reproducible from its seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Harness {
  master: MasterOrchestrator;
  spawnCalls: number[];
  managed: () => any;
  quiesce: () => void;
}

function makeConfig(name: string, port: number, readyTimeout: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    port,
    clustering: {
      enabled: true,
      strategy: 'proxy',
      rollingRestart: { batchSize: 1, batchDelay: 0 },
    },
  };
}

/** Replace only the I/O-bound collaborators; keep the real reload/launch code. */
function harness(name: string): Harness {
  const master = new MasterOrchestrator();
  const m = master as any;
  const spawnCalls: number[] = [];
  let nextPid = 7000;

  m.autoReady = true;
  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (workerId: number, message: { type: 'ready' }) => void,
    ): SpawnedWorker {
      spawnCalls.push(workerId);
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
      return true;
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

  const managed = () => m.apps.get(name);

  return {
    master,
    spawnCalls,
    managed,
    // Break any surviving respawn loop so the test runner is not left with
    // an unbounded chain of timers.
    quiesce: () => {
      const app = managed();
      if (!app) return;
      app.stopping = true;
      for (const t of app.readyTimers.values()) clearTimeout(t);
      app.readyTimers.clear();
      for (const t of app.stableTimers.values()) clearTimeout(t);
      app.stableTimers.clear();
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

test('H4: a failed reload must not spawn anything for the retired replacement', async () => {
  // Seeded so a failure is reproducible; the seed only picks the (equivalent)
  // readyTimeout / port pair, never the assertions.
  const SEED = 20260723;
  const rand = mulberry32(SEED);
  const failures: string[] = [];

  // A short sequence of independent scenarios: each one starts an app, forces
  // a reload whose replacement never reports ready, and then asserts the
  // retire invariant holds for the next ~2 restart cycles.
  for (let iter = 0; iter < 2; iter++) {
    const readyTimeout = 220 + Math.floor(rand() * 60); // 220..279ms
    const port = 41_000 + Math.floor(rand() * 5_000);
    const name = `h4-app-${iter}`;
    const h = harness(name);
    cleanups.push(h.quiesce);

    await h.master.startApp(makeConfig(name, port, readyTimeout));
    const managed = h.managed();
    expect(managed.workers.length).toBe(1);
    expect(h.spawnCalls).toEqual([0]);

    // The replacement will never send 'ready'.
    (h.master as any).autoReady = false;

    await expect(h.master.reloadApp(name)).rejects.toThrow();

    // Post-condition of the failed reload: the replacement (id 1) has been
    // retired — it is no longer in managed.workers.
    const retiredIds = h.spawnCalls.filter((id) => !managed.workers.some((w: any) => w.id === id));
    expect(retiredIds).toContain(1);

    const spawnsAtRejection = h.spawnCalls.length;
    const retired = new Set(retiredIds);

    // PORT_RELEASE_DELAY is 500ms, so the parked restartWorker resumes about
    // `readyTimeout + 500`ms after the reload began. Watch for well over one
    // full cycle and assert the invariant after every step.
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const extra = h.spawnCalls.slice(spawnsAtRejection);
      const illegal = extra.filter((id) => retired.has(id));
      if (illegal.length > 0) {
        failures.push(
          `seed=${SEED} iter=${iter} readyTimeout=${readyTimeout}: ` +
            `${illegal.length} process(es) spawned for retired worker id(s) [${illegal.join(',')}] ` +
            `after reloadApp rejected — managed.workers is [${managed.workers
              .map((w: any) => w.id)
              .join(',')}], managed.spawned holds [${[...managed.spawned.keys()].join(',')}]`,
        );
        break;
      }
      await sleep(50);
    }

    h.quiesce();
  }

  expect(failures).toEqual([]);
});
