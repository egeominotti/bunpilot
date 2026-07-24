// ---------------------------------------------------------------------------
// H3 — INV-STOPPING-01: once stopApp resolves, no process exists for that app
// and none can be created.
//
// Hypothesis: restartWorker() (src/core/worker-launch.ts) awaits killWorker and
// then `await sleep(PORT_RELEASE_DELAY)` while holding NO app lock. A stopApp()
// that lands inside that window completes fully (kills workers, clears
// spawned/launchTokens, nulls startedAt, releases ports, resets `stopping` to
// false in its finally). When the sleep resolves, restartWorker resumes with no
// re-check and calls launchWorker(), resurrecting a stopped app.
//
// Deterministic property loop: a seeded PRNG picks how long after the stale
// callback the operator issues `stop`. For every seed the invariant asserted is
// the same: after `await master.stopApp(name)` resolves, the spawn count must
// never increase again and `managed.spawned` must stay empty.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

interface Ctx {
  spawnCalls: number[];
  killCalls: number;
  heartbeatStale: Map<number, (wid: number) => void>;
  nextPid: number;
}

function makeConfig(name: string, port: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    port,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
  };
}

function stub(master: MasterOrchestrator, ctx: Ctx): void {
  // biome-ignore lint/suspicious/noExplicitAny: private field injection
  const m = master as any;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      _onMessage: unknown,
      _onExit: unknown,
    ): SpawnedWorker {
      ctx.spawnCalls.push(workerId);
      return {
        // biome-ignore lint/suspicious/noExplicitAny: stub subprocess
        proc: {} as any,
        pid: ctx.nextPid++,
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
    async killWorker() {
      ctx.killCalls++;
      return 'exited' as const;
    },
    // Old process is still alive => restartWorker takes the kill+sleep path.
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
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor(workerId: number, onStale: (wid: number) => void) {
      ctx.heartbeatStale.set(workerId, onStale);
    },
    stopHeartbeatMonitor() {},
    onHeartbeat() {},
    stopAll() {},
  };

  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

/** Deterministic 32-bit LCG. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const PORT_RELEASE_DELAY = 500;

test('INV-STOPPING-01: stopApp is not undone by an in-flight restartWorker', async () => {
  const failures: string[] = [];

  for (const seed of [1, 7, 42, 1337]) {
    const rnd = makePrng(seed);
    // Operator stops the app somewhere inside the PORT_RELEASE_DELAY window.
    const stopAfterMs = Math.floor(rnd() * (PORT_RELEASE_DELAY - 100)) + 5;

    const ctx: Ctx = {
      spawnCalls: [],
      killCalls: 0,
      heartbeatStale: new Map(),
      nextPid: 6_000,
    };
    const master = new MasterOrchestrator();
    stub(master, ctx);

    const name = `h3-app-${seed}`;
    // biome-ignore lint/suspicious/noExplicitAny: private field access
    const apps = (master as any).apps as Map<string, { spawned: Map<number, unknown> }>;

    try {
      await master.startApp(makeConfig(name, 3_100 + seed));
      expect(ctx.spawnCalls.length).toBe(1);

      // A heartbeat-stale callback fires for worker 0 -> scheduleRestart.
      const onStale = ctx.heartbeatStale.get(0);
      expect(typeof onStale).toBe('function');
      onStale?.(0);

      // Let restartWorker reach its `await sleep(PORT_RELEASE_DELAY)`.
      await Bun.sleep(stopAfterMs);

      // Operator stops the app. This resolves fully (takes the app lock,
      // kills workers, releases ports) while restartWorker is still sleeping.
      await master.stopApp(name);

      const spawnsAtStop = ctx.spawnCalls.length;
      const status = master.getAppStatus(name);

      // Invariant check point: nothing may be created from here on.
      await Bun.sleep(PORT_RELEASE_DELAY + 250);

      const managed = apps.get(name);
      if (ctx.spawnCalls.length !== spawnsAtStop) {
        failures.push(
          `seed=${seed} stopAfterMs=${stopAfterMs}: spawn count grew ${spawnsAtStop} -> ` +
            `${ctx.spawnCalls.length} after stopApp resolved (app resurrected); ` +
            `status.status=${status?.status} startedAt=${String(status?.startedAt)}`,
        );
      }
      if ((managed?.spawned.size ?? 0) !== 0) {
        failures.push(
          `seed=${seed} stopAfterMs=${stopAfterMs}: managed.spawned.size=${managed?.spawned.size} ` +
            `after stopApp resolved (live child process for a stopped app)`,
        );
      }
    } finally {
      await master.shutdown('SIGTERM').catch(() => undefined);
    }
  }

  expect(failures).toEqual([]);
});
