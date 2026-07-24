// ---------------------------------------------------------------------------
// H14 — restartWorker resurrects a worker into a torn-down app
// ---------------------------------------------------------------------------
//
// Invariant (WRK-12 / WRK-01): every process bunpilot has ever spawned must,
// once all lifecycle operations have settled, be EITHER
//   (a) tracked as a live worker of a running app (managed.spawned), OR
//   (b) have been signalled via ProcessManager.killWorker.
//
// restartWorker() awaits killWorker (up to killTimeout) and then
// sleep(PORT_RELEASE_DELAY) before calling launchWorker(). It never
// re-validates the app after those awaits, so an app-level teardown that
// interleaves (delete / stop / restart — all of which take withAppLock, which
// restartWorker does not hold) leaves the freshly spawned process orphaned.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

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
  staleCallbacks: Map<number, (wid: number) => void>;
  nextPid: number;
}

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
    port: 3000,
    ...overrides,
  };
}

function stub(master: MasterOrchestrator, ctx: Ctx): void {
  const m = master as any;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      _onMessage: (wid: number, msg: unknown) => void,
      _onExit: (wid: number, code: number | null, sig: string | null) => void,
    ): SpawnedWorker {
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
    // The old process is genuinely alive, so restartWorker takes the
    // kill + PORT_RELEASE_DELAY path (the production case).
    isRunning() {
      return true;
    },
  };

  m.logManager = {
    pipeOutput() {},
    closeAll() {},
  };

  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor(workerId: number, onStale: (wid: number) => void) {
      ctx.staleCallbacks.set(workerId, onStale);
    },
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

  // WorkerHandler must use the stubbed processManager.
  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

/** Every spawned pid must be live-and-tracked, or killed. Returns violations. */
function auditOrphans(master: MasterOrchestrator, ctx: Ctx, appName: string): number[] {
  const apps = (master as any).apps as Map<string, any>;
  const managed = apps.get(appName);
  const killed = new Set(ctx.killCalls);
  const tracked = new Set<number>();
  if (managed && managed.startedAt !== null) {
    for (const sp of managed.spawned.values() as Iterable<SpawnedWorker>) tracked.add(sp.pid);
  }
  return ctx.spawnCalls.map((s) => s.pid).filter((pid) => !killed.has(pid) && !tracked.has(pid));
}

function cleanup(master: MasterOrchestrator): void {
  const m = master as any;
  for (const managed of m.apps.values()) {
    m.workerHandler.cleanupApp(managed);
  }
  m.apps.clear();
}

type Op = 'delete' | 'stop' | 'restart';

test('no worker is resurrected into a torn-down app during restartWorker', async () => {
  const ops: Op[] = ['delete', 'stop', 'restart'];
  const failures: string[] = [];

  for (let i = 0; i < ops.length * 2; i++) {
    const seed = 1000 + i;
    const localRng = makeRng(seed);
    const op = ops[i % ops.length] as Op;
    // Interleave somewhere inside the kill+PORT_RELEASE_DELAY window (500ms).
    const delay = 10 + Math.floor(localRng() * 380);

    const ctx: Ctx = {
      spawnCalls: [],
      killCalls: [],
      staleCallbacks: new Map(),
      nextPid: 5000,
    };
    const master = new MasterOrchestrator();
    stub(master, ctx);

    try {
      await master.startApp(makeConfig());
      expect(ctx.spawnCalls.length).toBe(1);

      // Production trigger: the worker's heartbeat goes stale -> scheduleRestart.
      const onStale = ctx.staleCallbacks.get(0);
      expect(typeof onStale).toBe('function');
      (onStale as (wid: number) => void)(0);

      // ...operator interleaves an app-level lifecycle op mid-restart.
      await sleep(delay);
      if (op === 'delete') await master.deleteApp('test-app');
      else if (op === 'stop') await master.stopApp('test-app');
      else await master.restartApp('test-app');

      // Let the in-flight restartWorker finish its PORT_RELEASE_DELAY sleep.
      await sleep(900);

      const orphans = auditOrphans(master, ctx, 'test-app');
      if (orphans.length > 0) {
        failures.push(
          `seed=${seed} op=${op} delayMs=${delay}: orphan pids ${JSON.stringify(orphans)} ` +
            `(spawned=${JSON.stringify(ctx.spawnCalls)} killed=${JSON.stringify(ctx.killCalls)} ` +
            `appStillRegistered=${(master as any).apps.has('test-app')})`,
        );
      }
    } finally {
      cleanup(master);
    }
  }

  expect(failures).toEqual([]);
}, 20_000);
