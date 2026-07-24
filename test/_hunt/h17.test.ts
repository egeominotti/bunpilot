// ---------------------------------------------------------------------------
// h17 — RL-4/RL-6: a retired worker must never spawn a process afterwards.
// ---------------------------------------------------------------------------
//
// `retireWorker` (src/core/master.ts) splices a WorkerInfo out of
// managed.workers, deletes its launch token and its restartingWorkers entry.
// But `restartWorker` (src/core/worker-launch.ts) holds a live reference to
// that same object across `await killWorker(...)` and, on resume, calls
// `launchWorker` unconditionally — re-registering managed.launchTokens /
// managed.spawned and spawning a real OS process for a worker the orchestrator
// has already forgotten.
//
// Invariant asserted here: once everything has settled, the set of live PIDs
// must equal exactly the set of PIDs of the workers the orchestrator still
// tracks. Anything else is an orphan process no `status`, `stop`, `restart`,
// `delete` or daemon shutdown can ever reach.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

// --- seeded deterministic PRNG (mulberry32) --------------------------------
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function makeConfig(name: string): AppConfig {
  return {
    name,
    script: 'app.ts',
    // No `port` -> no proxy, and restartWorker skips its 500ms port-release
    // sleep, which keeps this test fast. The race is identical either way.
    instances: 1,
    maxRestarts: 5,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 10_000,
    backoff: { initial: 60_000, multiplier: 2, max: 60_000 },
    clustering: {
      enabled: true,
      strategy: 'proxy',
      rollingRestart: { batchSize: 1, batchDelay: 0 },
    },
  } as AppConfig;
}

interface Harness {
  master: MasterOrchestrator;
  managed: any;
  alive: Map<number, number>; // pid -> workerId it was spawned for
  spawnLog: Array<{ wid: number; pid: number }>;
  staleCbs: Map<number, (wid: number) => void>;
}

function buildHarness(_name: string, killDelay: number): Harness {
  const master = new MasterOrchestrator();
  const m = master as any;

  let nextPid = 9000;
  const alive = new Map<number, number>();
  const spawnLog: Array<{ wid: number; pid: number }> = [];
  const staleCbs = new Map<number, (wid: number) => void>();

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (wid: number, msg: { type: 'ready' }) => void,
    ): SpawnedWorker {
      const pid = nextPid++;
      alive.set(pid, workerId);
      spawnLog.push({ wid: workerId, pid });
      queueMicrotask(() => onMessage(workerId, { type: 'ready' }));
      return {
        proc: {} as any,
        pid,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      };
    },
    async killWorker(pid: number) {
      // A real SIGTERM + wait-for-exit takes time; this is the window in which
      // the reload retires the worker underneath the in-flight restart.
      await sleep(killDelay);
      alive.delete(pid);
      return 'exited' as const;
    },
    isRunning(pid: number) {
      return alive.has(pid);
    },
  };

  m.logManager = {
    pipeOutput() {},
    closeAll() {},
    closeApp() {},
    closeWorker() {},
  };

  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor(workerId: number, cb: (wid: number) => void) {
      staleCbs.set(workerId, cb);
    },
    stopHeartbeatMonitor(workerId: number) {
      staleCbs.delete(workerId);
    },
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

  return { master, managed: null, alive, spawnLog, staleCbs };
}

test('a retired worker never spawns a process afterwards (RL-4/RL-6)', async () => {
  const SEED = 0x11_17;
  const rand = mulberry32(SEED);
  const violations: string[] = [];

  for (let iteration = 0; iteration < 5; iteration++) {
    // killDelay > 100ms so the restart's kill is still in flight when the
    // reload's pollUntil (100ms tick) hands control to the drain.
    const killDelay = 120 + Math.floor(rand() * 80);
    const fireDelay = 5 + Math.floor(rand() * 55);
    const name = `h17-app-${iteration}`;
    const h = buildHarness(name, killDelay);
    const m = h.master as any;

    try {
      await h.master.startApp(makeConfig(name));
      const managed = m.apps.get(name);
      await sleep(10);
      expect(managed.workers.length).toBe(1);
      expect(managed.workers[0].state).toBe('online');

      // A normal zero-downtime reload...
      const reload = h.master.reloadApp(name);

      // ...during which the OLD worker is flagged heartbeat-stale (one of the
      // four unlocked callers of scheduleRestart). This starts an async
      // restartWorker() that is suspended on `await killWorker(...)` while the
      // reload drains and RETIRES that very same WorkerInfo.
      await sleep(fireDelay);
      h.staleCbs.get(0)?.(0);

      await reload;

      // Let the suspended restartWorker() resume and do whatever it does.
      await sleep(killDelay + 250);

      const trackedIds: number[] = managed.workers.map((w: any) => w.id);
      const trackedPids = new Set<number>(managed.workers.map((w: any) => w.pid));
      const livePids = [...h.alive.keys()].sort((a, b) => a - b);

      // INVARIANT: every process still running belongs to a worker the
      // orchestrator still tracks (and can therefore still kill).
      const orphanPids = livePids.filter((pid) => !trackedPids.has(pid));
      if (orphanPids.length > 0) {
        violations.push(
          `seed=${SEED} iteration=${iteration} killDelay=${killDelay} fireDelay=${fireDelay}: ` +
            `orphan pids ${JSON.stringify(orphanPids)} ` +
            `(spawned for retired worker ids ${JSON.stringify(
              orphanPids.map((pid) => h.alive.get(pid)),
            )}); tracked workers=${JSON.stringify(trackedIds)}; ` +
            `spawnLog=${JSON.stringify(h.spawnLog)}`,
        );
      }

      // INVARIANT: managed.spawned may only hold entries for tracked workers.
      const strayKeys = [...managed.spawned.keys()].filter(
        (id: number) => !trackedIds.includes(id),
      );
      if (strayKeys.length > 0) {
        violations.push(
          `seed=${SEED} iteration=${iteration}: managed.spawned re-gained retired worker ids ` +
            `${JSON.stringify(strayKeys)}`,
        );
      }
    } finally {
      await h.master.deleteApp(name).catch(() => undefined);
      await (h.master as any).healthChecker.stopAll?.();
    }

    if (violations.length > 0) break;
  }

  expect(violations).toEqual([]);
}, 20_000);
