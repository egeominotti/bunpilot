// ---------------------------------------------------------------------------
// H47 – stopAllWorkers must never drop a pid handle it did not kill
// ---------------------------------------------------------------------------
//
// Invariant under test: `managed.spawned` is the daemon's ONLY record of live
// worker pids, and `managed.launchTokens` is the only path by which a live
// process can report its exit. Therefore every removal from those maps must be
// preceded by a successful kill of the corresponding process.
//
// `WorkerHandler.stopAllWorkers` awaits `Promise.all` of the per-worker kills
// and only afterwards runs `managed.spawned.clear()` / `launchTokens.clear()`
// (src/core/worker-handler.ts:234-235). `restartWorker` runs completely outside
// the app lock and parks in `await sleep(PORT_RELEASE_DELAY)` (500ms) before
// calling `launchWorker`. If any kill in the Promise.all takes longer than that
// remaining delay, the relaunch lands INSIDE the await window: it writes a
// brand-new live pid into `spawned` and a fresh token into `launchTokens`, and
// the trailing `clear()` then wipes both.
//
// Result: a live process the daemon can no longer kill (its pid handle is gone,
// so every later stopApp/deleteApp/shutdown is a no-op for it) and whose exit is
// never reported (its launch token was deleted). It keeps holding the app port,
// so subsequent starts fail with EADDRINUSE.
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

function makeConfig(name: string, port: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 2,
    maxRestarts: 10,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    // Long enough that no ready-timeout timer can fire during the test.
    readyTimeout: 60_000,
    backoff: { initial: 60_000, multiplier: 2, max: 60_000 },
    port,
    clustering: {
      enabled: true,
      strategy: 'proxy',
      rollingRestart: { batchSize: 1, batchDelay: 0 },
    },
  };
}

interface Harness {
  master: MasterOrchestrator;
  spawnCalls: number[];
  spawnedPids: number[];
  killCalls: number[];
  alive: Set<number>;
  /** pid -> ms the kill of that pid takes before the process actually dies. */
  killDelay: Map<number, number>;
  staleCallbacks: Map<number, (wid: number) => void>;
  managed: () => any;
  quiesce: () => void;
}

/** Replace only the I/O-bound collaborators; keep the real lifecycle code. */
function harness(name: string): Harness {
  const master = new MasterOrchestrator();
  const m = master as any;
  const spawnCalls: number[] = [];
  const spawnedPids: number[] = [];
  const killCalls: number[] = [];
  const alive = new Set<number>();
  const killDelay = new Map<number, number>();
  const staleCallbacks = new Map<number, (wid: number) => void>();
  let nextPid = 5000;

  m.autoReady = true;
  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (workerId: number, message: { type: 'ready' }) => void,
    ): SpawnedWorker {
      const pid = nextPid++;
      spawnCalls.push(workerId);
      spawnedPids.push(pid);
      alive.add(pid);
      const spawned = {
        proc: {} as any,
        pid,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      };
      if (m.autoReady) queueMicrotask(() => onMessage(workerId, { type: 'ready' }));
      return spawned;
    },
    async killWorker(pid: number) {
      killCalls.push(pid);
      const delay = killDelay.get(pid) ?? 0;
      if (delay > 0) await sleep(delay);
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
      staleCallbacks.set(workerId, cb);
    },
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
    spawnedPids,
    killCalls,
    alive,
    killDelay,
    staleCallbacks,
    managed,
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

test('H47: a worker relaunched during stop must keep its pid handle', async () => {
  const SEED = 47_20260723;
  const rand = mulberry32(SEED);
  const failures: string[] = [];

  // Each iteration: 2-instance proxied app, worker 0's heartbeat goes stale
  // (restartWorker parks in the 500ms PORT_RELEASE_DELAY), then stopApp runs
  // while worker 1's kill takes longer than that remaining delay.
  for (let iter = 0; iter < 3 && failures.length === 0; iter++) {
    const name = `h47-app-${iter}`;
    const port = 45_000 + Math.floor(rand() * 3_000);
    // Fast kill for worker 0's old process, slow kill for worker 1 so that the
    // relaunch lands strictly inside stopAllWorkers' Promise.all await window.
    const fastKill = Math.floor(rand() * 15); // 0..14ms
    const slowKill = 600 + Math.floor(rand() * 120); // 600..719ms  (> 500ms)

    const h = harness(name);
    cleanups.push(h.quiesce);

    await h.master.startApp(makeConfig(name, port));
    await sleep(20); // let the queued 'ready' messages land

    const managed = h.managed();
    expect(h.spawnCalls).toEqual([0, 1]);
    expect(managed.workers.map((w: any) => w.state)).toEqual(['online', 'online']);

    const pid0 = h.spawnedPids[0] as number;
    const pid1 = h.spawnedPids[1] as number;
    h.killDelay.set(pid0, fastKill);
    h.killDelay.set(pid1, slowKill);

    // Worker 0's heartbeat goes stale -> scheduleRestart -> restartWorker parks
    // in `await sleep(PORT_RELEASE_DELAY)` (500ms), outside the app lock.
    const stale = h.staleCallbacks.get(0);
    expect(typeof stale).toBe('function');
    stale?.(0);

    // The operator stops the app while that restart is still in flight.
    await h.master.stopApp(name);
    // Let the parked relaunch (if any) finish landing.
    await sleep(150);

    const trackedPids = new Set<number>(
      [...managed.spawned.values()].map((s: any) => s.pid as number),
    );
    const untracked = [...h.alive].filter((pid) => !trackedPids.has(pid));

    if (untracked.length > 0) {
      // Prove it is permanently orphaned: a second stop issues no kill for it.
      const killsBefore = h.killCalls.length;
      await h.master.stopApp(name);
      const stillAlive = untracked.filter((pid) => h.alive.has(pid));

      failures.push(
        `seed=${SEED} iter=${iter} fastKill=${fastKill}ms slowKill=${slowKill}ms: ` +
          `pid(s) [${untracked.join(',')}] are still alive but absent from managed.spawned ` +
          `(spawn ids [${h.spawnCalls.join(',')}], pids [${h.spawnedPids.join(',')}], ` +
          `killed [${h.killCalls.join(',')}]); managed.spawned keys=[${[
            ...managed.spawned.keys(),
          ].join(
            ',',
          )}], managed.launchTokens keys=[${[...managed.launchTokens.keys()].join(',')}]. ` +
          `A second stopApp issued ${h.killCalls.length - killsBefore} extra kill(s) and left ` +
          `[${stillAlive.join(',')}] running — unkillable by the daemon forever.`,
      );
    }

    h.quiesce();
  }

  expect(failures).toEqual([]);
}, 20_000);
