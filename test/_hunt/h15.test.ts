// ---------------------------------------------------------------------------
// H15 — stopApp during crash-backoff: an in-flight restartWorker revives the
//        app AFTER the daemon has reported it stopped.
// ---------------------------------------------------------------------------
//
// Invariant (AGENTS.md): "A stopped or deleting app must not be resurrected by
// health, heartbeat, readiness, or crash timers." and "Public and internal
// ports ... are released on stop".
//
// Path under test:
//   worker crashes -> WorkerHandler.handleExit arms a crash-backoff timer
//   (worker-handler.ts:139) -> timer fires -> scheduleRestart -> restartWorker
//   parks in `await sleep(PORT_RELEASE_DELAY)` (worker-launch.ts:95).
//
// restartWorker re-checks `managed.stopping` after the awaits
// (worker-launch.ts:102), but stopAppUnlocked resets `managed.stopping = false`
// in its `finally` (master.ts:145) and never removes the worker from
// `managed.workers`, so once stopApp() has RESOLVED that guard is already back
// to its permissive value. The parked restart therefore resumes and calls
// launchWorker() -> spawnWorker() on an app whose `startedAt` is null and whose
// internal ports have been released.
//
// Note: `restartWorker` holds no app lock, so it is not serialised against
// stopApp()'s withAppLock().
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

// --- deterministic PRNG (mulberry32) ---------------------------------------
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
  /** Every spawnWorker() call, in order. */
  spawns: Array<{ workerId: number; pid: number; at: number }>;
  killedPids: number[];
  /** onExit callback handed to spawnWorker, per worker id (latest generation). */
  exitCallbacks: Map<number, (wid: number, code: number | null, sig: string | null) => void>;
  nextPid: number;
}

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'h15-app',
    script: 'app.ts',
    instances: 1,
    maxRestarts: 5,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    // Fast crash backoff so the timer fires well inside the test window.
    backoff: { initial: 10, multiplier: 2, max: 30_000 },
    // A port (and no reuse-port clustering) is what makes restartWorker take
    // the `await sleep(PORT_RELEASE_DELAY)` branch — the race window.
    port: 3000,
    ...overrides,
  };
}

/** Replace only the I/O-bound collaborators; keep real lifecycle logic. */
function stub(master: MasterOrchestrator, ctx: Ctx): void {
  const m = master as unknown as Record<string, unknown>;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      _onMessage: (wid: number, msg: unknown) => void,
      onExit: (wid: number, code: number | null, sig: string | null) => void,
    ): SpawnedWorker {
      const pid = ctx.nextPid++;
      ctx.spawns.push({ workerId, pid, at: Date.now() });
      ctx.exitCallbacks.set(workerId, onExit);
      return {
        proc: {} as never,
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
      ctx.killedPids.push(pid);
      return 'exited' as const;
    },
    // The crashed process is genuinely gone: restartWorker skips the kill and
    // goes straight to the PORT_RELEASE_DELAY sleep.
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
    getWorkerPort() {
      return undefined;
    },
    isHeartbeatStale() {
      return false;
    },
  };

  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {},
  });

  // The handler must talk to the stubbed processManager.
  m.workerHandler = new WorkerHandler(
    m.processManager as never,
    m.crashRecovery as never,
    m.lifecycle as never,
  );
}

interface ManagedLike {
  startedAt: number | null;
  stopping: boolean;
  workers: Array<{ id: number; state: string }>;
  spawned: Map<number, SpawnedWorker>;
  workerPorts: Map<number, number>;
}

function getManaged(master: MasterOrchestrator, name: string): ManagedLike | undefined {
  return (master as unknown as { apps: Map<string, ManagedLike> }).apps.get(name);
}

function cleanup(master: MasterOrchestrator): void {
  const m = master as unknown as {
    apps: Map<string, unknown>;
    workerHandler: { cleanupApp: (managed: unknown) => void };
  };
  for (const managed of m.apps.values()) m.workerHandler.cleanupApp(managed);
  m.apps.clear();
}

/**
 * Invariant check for a stopped app: nothing may have been spawned after the
 * stop completed, and no process may still be tracked as live.
 */
function violations(ctx: Ctx, managed: ManagedLike | undefined, stopFinishedAt: number): string[] {
  const out: string[] = [];
  const late = ctx.spawns.filter((s) => s.at >= stopFinishedAt);
  if (late.length > 0) {
    out.push(`spawned after stop resolved: ${JSON.stringify(late)}`);
  }
  if (managed) {
    if (managed.startedAt !== null) out.push(`startedAt=${managed.startedAt} (expected null)`);
    if (managed.spawned.size > 0) {
      out.push(`managed.spawned still tracks ${JSON.stringify([...managed.spawned.keys()])}`);
    }
    const live = managed.workers.filter(
      (w) => w.state !== 'stopped' && w.state !== 'errored' && w.state !== 'crashed',
    );
    if (live.length > 0) {
      out.push(`workers not stopped: ${JSON.stringify(live.map((w) => [w.id, w.state]))}`);
    }
  }
  return out;
}

test('crash-backoff restart must not resurrect an app that was stopped mid-flight', async () => {
  const failures: string[] = [];
  // Each seed picks a different point inside the 500 ms PORT_RELEASE_DELAY
  // window at which the operator runs `bunpilot stop`.
  const seeds = [4101, 4102, 4103, 4104];

  for (const seed of seeds) {
    const rng = makeRng(seed);
    // Backoff timer fires ~10 ms after the crash; wait past that, then stop
    // somewhere inside the remaining port-release window.
    const stopAfterMs = 30 + Math.floor(rng() * 300);

    const ctx: Ctx = { spawns: [], killedPids: [], exitCallbacks: new Map(), nextPid: 7000 };
    const master = new MasterOrchestrator();
    stub(master, ctx);
    const name = 'h15-app';

    try {
      await master.startApp(makeConfig());
      // Step 1 invariant: exactly one process for one instance.
      expect(ctx.spawns.length).toBe(1);

      // Step 2: the worker crashes -> handleExit arms the backoff timer.
      const onExit = ctx.exitCallbacks.get(0);
      expect(typeof onExit).toBe('function');
      (onExit as (w: number, c: number | null, s: string | null) => void)(0, 1, null);
      expect(getManaged(master, name)?.workers[0]?.state).toBe('crashed');

      // Step 3: the timer fires and restartWorker parks in sleep(500);
      // meanwhile the operator stops the app.
      await sleep(stopAfterMs);
      await master.stopApp(name);
      const stopFinishedAt = Date.now();

      const managed = getManaged(master, name);
      // Step 4 invariant: immediately after stopApp resolves the app is stopped.
      const immediate = violations(ctx, managed, stopFinishedAt);
      if (immediate.length > 0) {
        failures.push(
          `seed=${seed} stopAfterMs=${stopAfterMs} [immediately after stop]: ${immediate.join('; ')}`,
        );
      }

      // Step 5: let any parked restartWorker finish its PORT_RELEASE_DELAY.
      await sleep(700);

      const settled = violations(ctx, getManaged(master, name), stopFinishedAt);
      if (settled.length > 0) {
        failures.push(
          `seed=${seed} stopAfterMs=${stopAfterMs} [after settle]: ${settled.join('; ')} ` +
            `| spawns=${JSON.stringify(ctx.spawns.map((s) => s.pid))} ` +
            `killed=${JSON.stringify(ctx.killedPids)}`,
        );
      }
    } finally {
      cleanup(master);
    }
  }

  expect(failures).toEqual([]);
}, 20_000);
