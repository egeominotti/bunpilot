// ---------------------------------------------------------------------------
// H25 — the hardcoded 30s heartbeat grace preempts readyTimeout
// ---------------------------------------------------------------------------
//
// Invariant: a worker that is still inside its configured `readyTimeout`
// window must not be torn down and respawned by the heartbeat-staleness path.
// `readyTimeout` is the single authority on "how long may this worker take to
// become ready" (validator allows 1_000..300_000 ms) and it owns its own timer
// (WorkerHandler.scheduleReadyTimeout).
//
// Today `HealthChecker.startHeartbeatMonitor` stamps `monitorStartedAt =
// Date.now()` at LAUNCH time and `isHeartbeatStale` compares against a
// hardcoded `HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD` (30_000 ms). The
// worker SDK only starts emitting heartbeats from inside `bunpilotReady()`
// (src/sdk/worker.ts:33-37), so a worker that legitimately needs > 30s to boot
// (migrations, cache warm-up) has emitted nothing at t=30s and is declared
// stale. `startWorkerMonitors`' onStale handler (worker-launch.ts) restarts any
// worker in state 'online' OR 'starting' — so it kills a worker that is still
// well inside its 120s readyTimeout.
//
// Worse, `restartWorker` forces `worker.state = 'stopping'` before the kill, so
// `handleExit` scores the exit as a graceful stop: `consecutiveCrashes` stays
// 0, no backoff is applied, `maxRestarts` never trips. The relaunch re-stamps
// the baseline and the cycle repeats every ~30s forever.
//
// This test drives the REAL HealthChecker (its baseline + staleness math) with
// a mocked clock and only stubs the *timer* so the 30s window doesn't have to
// elapse in wall time. It therefore stays honest for a fix on either side:
// a checker-side grace/baseline fix makes `isHeartbeatStale` false, and a
// worker-launch-side guard makes the onStale handler a no-op.
// ---------------------------------------------------------------------------

import { afterEach, expect, setSystemTime, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { HEARTBEAT_INTERVAL, HEARTBEAT_MISS_THRESHOLD } from '../../src/constants';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';
import { HealthChecker } from '../../src/health/checker';

const STALE_WINDOW = HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD; // 30_000

// --- deterministic PRNG (mulberry32) --------------------------------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface Ctx {
  spawnCalls: Array<{ workerId: number; pid: number }>;
  killCalls: number[];
  /** onStale callbacks handed to startHeartbeatMonitor, keyed by workerId. */
  staleCallbacks: Map<number, (wid: number) => void>;
  real: HealthChecker;
  nextPid: number;
}

function makeConfig(readyTimeout: number): AppConfig {
  return {
    name: 'slow-boot-app',
    script: 'app.ts',
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    // no `port` → restartWorker skips the PORT_RELEASE_DELAY sleep, so the
    // respawn (if any) lands well inside the test's settle window.
  };
}

function stub(master: MasterOrchestrator, ctx: Ctx): void {
  const m = master as any;

  m.processManager = {
    spawnWorker(_config: AppConfig, workerId: number): SpawnedWorker {
      const pid = ctx.nextPid++;
      ctx.spawnCalls.push({ workerId, pid });
      return {
        proc: {} as any,
        pid,
        stdout: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      };
    },
    async killWorker(pid: number) {
      ctx.killCalls.push(pid);
      return 'exited' as const;
    },
    isRunning() {
      return true;
    },
  };

  m.logManager = {
    pipeOutput() {},
    closeAll() {},
    closeApp() {},
  };

  // Real HealthChecker semantics, stubbed *scheduling* only: we forward every
  // argument through so a fix that widens the API (e.g. an extra grace-period
  // parameter) is still exercised, capture the production onStale callback, and
  // fire ticks manually instead of waiting 30s of wall time.
  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking() {},
    stopChecking(wid: number, ns?: string) {
      ctx.real.stopChecking(wid, ns);
    },
    startHeartbeatMonitor(
      workerId: number,
      onStale: (wid: number) => void,
      namespace?: string,
      ...rest: unknown[]
    ) {
      ctx.staleCallbacks.set(workerId, onStale);
      // Pass a no-op onStale to the real checker: we drive the tick ourselves.
      (ctx.real.startHeartbeatMonitor as any)(workerId, () => {}, namespace, ...rest);
    },
    stopHeartbeatMonitor(wid: number, ns?: string) {
      ctx.real.stopHeartbeatMonitor(wid, ns);
    },
    onHeartbeat(wid: number, ns?: string) {
      ctx.real.onHeartbeat(wid, ns);
    },
    stopAll() {
      ctx.real.stopAll();
    },
    getWorkerPort() {
      return undefined;
    },
    isHeartbeatStale(wid: number, ns?: string) {
      return ctx.real.isHeartbeatStale(wid, ns);
    },
  };

  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

/** Reproduce exactly what the real monitor's setInterval body does. */
function tickHeartbeatMonitor(ctx: Ctx, workerId: number, namespace: string): boolean {
  if (!ctx.real.isHeartbeatStale(workerId, namespace)) return false;
  const cb = ctx.staleCallbacks.get(workerId);
  if (!cb) return false;
  cb(workerId);
  return true;
}

function cleanup(master: MasterOrchestrator, ctx: Ctx): void {
  const m = master as any;
  for (const managed of m.apps.values()) {
    m.workerHandler.cleanupApp(managed);
  }
  m.apps.clear();
  ctx.real.stopAll();
}

afterEach(() => {
  setSystemTime(); // restore the real clock
});

test('a worker still inside its readyTimeout is not restarted by heartbeat staleness', async () => {
  const failures: string[] = [];
  const CASES = 8;

  for (let i = 0; i < CASES; i++) {
    const seed = 25_000 + i;
    const rng = makeRng(seed);

    // readyTimeout well above the hardcoded 30s stale window, but inside the
    // validator's legal 1_000..300_000 range (src/config/validator.ts).
    const readyTimeout = 45_000 + Math.floor(rng() * 255_000);
    // Elapsed time at which we tick: past the 30s stale window, but still
    // comfortably inside readyTimeout — the worker is legitimately booting.
    const span = readyTimeout - 5_000 - STALE_WINDOW;
    const elapsed = STALE_WINDOW + Math.floor(rng() * Math.max(1, span));

    const t0 = Date.UTC(2026, 0, 1, 0, 0, 0) + i * 1_000;
    const ctx: Ctx = {
      spawnCalls: [],
      killCalls: [],
      staleCallbacks: new Map(),
      real: new HealthChecker(),
      nextPid: 7000 + i * 10,
    };
    const master = new MasterOrchestrator();
    stub(master, ctx);

    try {
      setSystemTime(new Date(t0));
      const config = makeConfig(readyTimeout);
      await master.startApp(config);

      const managed = (master as any).apps.get(config.name);
      const worker = managed.workers[0];

      expect(ctx.spawnCalls.length).toBe(1);
      expect(worker.state).toBe('starting');
      expect(worker.restartCount).toBe(0);

      // The worker is mid-boot: it has NOT called bunpilotReady(), therefore it
      // has emitted no heartbeat yet (src/sdk/worker.ts only starts heartbeats
      // inside bunpilotReady). Advance the clock.
      setSystemTime(new Date(t0 + elapsed));

      const staleFired = tickHeartbeatMonitor(ctx, 0, config.name);
      await sleep(60);

      const stillStarting = worker.state === 'starting' || worker.state === 'spawning';
      if (ctx.spawnCalls.length !== 1 || worker.restartCount !== 0) {
        failures.push(
          `seed=${seed} readyTimeout=${readyTimeout}ms elapsed=${elapsed}ms ` +
            `(${(readyTimeout - elapsed).toLocaleString()}ms of readyTimeout budget left): ` +
            `isHeartbeatStale=${staleFired} spawns=${ctx.spawnCalls.length} ` +
            `restartCount=${worker.restartCount} state=${worker.state} ` +
            `kills=${JSON.stringify(ctx.killCalls)} consecutiveCrashes=${worker.consecutiveCrashes} ` +
            `stillStarting=${stillStarting}`,
        );
      }
    } finally {
      cleanup(master, ctx);
      setSystemTime();
    }
  }

  expect(failures).toEqual([]);
}, 20_000);
