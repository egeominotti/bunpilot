// ---------------------------------------------------------------------------
// h57 — INV-RETIRE-01 / INV-LOCK-01
//
// A worker retired by `reloadApp` (spliced out of managed.workers) must never
// be relaunched, and every pid in managed.spawned must be reachable from
// managed.workers so stopAllWorkers can kill it.
//
// Race: scheduleRestart -> restartWorker kills the old child and then awaits
// PORT_RELEASE_DELAY (500 ms, worker-launch.ts:95) holding NO app lock. A
// reload landing inside that window drains + retires the very WorkerInfo the
// in-flight restartWorker still holds a reference to. When the sleep resolves,
// restartWorker calls launchWorker() on the retired WorkerInfo, spawning a
// fresh child registered in managed.spawned under an id that no longer exists
// in managed.workers => untrackable orphan process.
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import type { AppConfig, WorkerMessage } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

// --- deterministic PRNG (mulberry32) ---------------------------------------
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface SpawnCall {
  workerId: number;
  pid: number;
}

interface Harness {
  master: MasterOrchestrator;
  spawnCalls: SpawnCall[];
  send: (workerId: number, msg: WorkerMessage) => void;
  fireStale: (workerId: number) => void;
  managed: () => any;
  cleanup: () => Promise<void>;
}

function makeConfig(name: string, port: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    // A public port is what arms restartWorker's PORT_RELEASE_DELAY sleep,
    // i.e. the unlocked window this race lives in. Never bound: the process
    // manager is stubbed, nothing listens.
    port,
    instances: 1,
    maxRestarts: 10,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 100,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 5_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    clustering: {
      enabled: true,
      strategy: 'proxy',
      rollingRestart: { batchSize: 1, batchDelay: 0 },
    },
  };
}

function harness(name: string, port: number): Harness {
  const master = new MasterOrchestrator();
  const m = master as any;

  const spawnCalls: SpawnCall[] = [];
  const messageCbs = new Map<number, (wid: number, msg: WorkerMessage) => void>();
  const staleCbs = new Map<number, (wid: number) => void>();
  let nextPid = 9001;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (wid: number, msg: WorkerMessage) => void,
      _onExit: unknown,
      _port?: number,
    ): SpawnedWorker {
      const pid = nextPid++;
      spawnCalls.push({ workerId, pid });
      messageCbs.set(workerId, onMessage);
      return {
        proc: {} as any,
        pid,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      } as SpawnedWorker;
    },
    async killWorker() {
      return 'exited' as const;
    },
    isRunning() {
      return true;
    },
  };

  m.logManager = {
    pipeOutput() {},
    async closeAll() {},
    async closeApp() {},
    async closeWorker() {},
  };

  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor(workerId: number, cb: (wid: number) => void) {
      staleCbs.set(workerId, cb);
    },
    stopHeartbeatMonitor() {},
    onHeartbeat() {},
    stopAll() {},
    getWorkerPort: () => port,
    isHeartbeatStale: () => false,
  };

  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {},
  });

  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);

  return {
    master,
    spawnCalls,
    send: (workerId, msg) => messageCbs.get(workerId)?.(workerId, msg),
    fireStale: (workerId) => staleCbs.get(workerId)?.(workerId),
    managed: () => m.apps.get(name),
    cleanup: async () => {
      try {
        await master.shutdown('SIGTERM');
      } catch {
        // ignore
      }
      // Drop any timer still armed by an orphaned launch so the runner exits.
      for (const app of m.apps.values()) {
        for (const t of app.readyTimers.values()) clearTimeout(t);
        for (const t of app.stableTimers.values()) clearTimeout(t);
        app.readyTimers.clear();
        app.stableTimers.clear();
      }
    },
  };
}

const pending: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (pending.length) await pending.pop()?.();
});

test('INV-RETIRE-01: reload must not leave a retired worker relaunched by an in-flight restart', async () => {
  const seeds = [1, 7, 13, 29];
  const failures: string[] = [];

  for (const seed of seeds) {
    const next = prng(seed);
    // Issue the reload somewhere inside restartWorker's 500 ms PORT_RELEASE_DELAY.
    const reloadDelay = Math.floor(next() * 120) + 5;

    const name = `h57-${seed}`;
    const port = 40_000 + 1_000 + seed;
    const h = harness(name, port);
    pending.push(h.cleanup);

    await h.master.startApp(makeConfig(name, port));
    const managed = h.managed();
    expect(managed.workers.length).toBe(1);

    // Worker 0 comes online.
    h.send(0, { type: 'ready' } as WorkerMessage);
    expect(managed.workers[0].state).toBe('online');

    // Heartbeat goes stale -> scheduleRestart -> restartWorker kills the child
    // and parks in the PORT_RELEASE_DELAY sleep, holding no lock.
    h.fireStale(0);
    await sleep(reloadDelay);

    // Operator reloads inside that window.
    const reloading = h.master.reloadApp(name);
    await sleep(20);
    // The replacement (id 1) reports ready so the rolling restart drains id 0.
    h.send(1, { type: 'ready' } as WorkerMessage);
    await reloading;

    // Worker 0 was retired by the reload.
    expect(managed.workers.map((w: any) => w.id)).toEqual([1]);

    // Let the parked PORT_RELEASE_DELAY sleep resolve.
    await sleep(700);

    const liveIds = new Set<number>(managed.workers.map((w: any) => w.id));
    const spawnedIds = [...managed.spawned.keys()] as number[];
    const untracked = spawnedIds.filter((id) => !liveIds.has(id));
    const relaunches = h.spawnCalls.filter((c) => c.workerId === 0).length;

    if (untracked.length > 0 || relaunches !== 1) {
      failures.push(
        `seed=${seed} reloadDelay=${reloadDelay}ms ` +
          `spawnCalls=${JSON.stringify(h.spawnCalls)} ` +
          `workers=${JSON.stringify(managed.workers.map((w: any) => `${w.id}:${w.state}`))} ` +
          `spawnedKeys=${JSON.stringify(spawnedIds)} untrackedSpawned=${JSON.stringify(untracked)} ` +
          `worker0Launches=${relaunches}`,
      );
    }
  }

  expect(failures).toEqual([]);
}, 20_000);
