// ---------------------------------------------------------------------------
// h46 — INV-SHUTDOWN-01: shutdown must fence new lifecycle operations.
//
// AGENTS.md: "Shutdown is idempotent and attempts cleanup for every app and
// registered resource even if one cleanup fails." After `shutdown()` resolves
// the orchestrator must own no live child processes.
//
// MasterOrchestrator.performShutdown() snapshots `[...this.apps.keys()]` and
// then awaits per-app stops. There is no `shuttingDown` flag consulted by
// startApp/restartApp, and the control server is only torn down by the
// shutdownCallbacks that run LAST. So any control command that lands inside
// the (multi-second) shutdown window spawns workers that the daemon then
// abandons when signals.ts calls process.exit(0).
//
// Property test: seeded PRNG picks the operation and the timings; the
// invariant "after shutdown() resolves, no app is running / no worker is
// alive" is asserted for every generated case.
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

// --- seeded PRNG (mulberry32) ---------------------------------------------
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

const LIVE_STATES = new Set(['spawning', 'starting', 'online', 'draining', 'stopping']);

interface Ctx {
  spawnCalls: string[];
  killDelay: number;
}

function makeConfig(name: string): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 2,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 60_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
  };
}

function stub(master: MasterOrchestrator, ctx: Ctx): void {
  const m = master as any;
  let nextPid = 5000;

  m.processManager = {
    spawnWorker(config: AppConfig, workerId: number): SpawnedWorker {
      ctx.spawnCalls.push(`${config.name}:${workerId}`);
      return {
        proc: {} as never,
        pid: nextPid++,
        stdout: new ReadableStream({
          start: (c) => c.close(),
        }),
        stderr: new ReadableStream({
          start: (c) => c.close(),
        }),
      };
    },
    async killWorker() {
      if (ctx.killDelay > 0) await Bun.sleep(ctx.killDelay);
      return 'exited' as const;
    },
    isRunning() {
      return false;
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
    startHeartbeatMonitor() {},
    stopHeartbeatMonitor() {},
    onHeartbeat() {},
    stopAll() {},
    getWorkerPort() {
      return 40001;
    },
    isHeartbeatStale() {
      return false;
    },
  };

  m.reloadHandler = { async rollingRestart() {} };
  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {},
  });

  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

function liveApps(master: MasterOrchestrator): string[] {
  return master
    .listApps()
    .filter((a) => a.status === 'running' || a.workers.some((w) => LIVE_STATES.has(w.state)))
    .map((a) => `${a.name}(${a.status})`);
}

const openMasters: Array<{ master: MasterOrchestrator; ctx: Ctx }> = [];

afterEach(async () => {
  for (const { master, ctx } of openMasters.splice(0)) {
    ctx.killDelay = 0;
    const names = [...((master as any).apps as Map<string, unknown>).keys()];
    await Promise.allSettled(names.map((n) => master.deleteApp(n)));
  }
});

test('INV-SHUTDOWN-01: no app is left running after shutdown() resolves', async () => {
  const failures: string[] = [];

  for (let seed = 1; seed <= 12; seed++) {
    const rnd = prng(seed);
    const op: 'start-new' | 'restart-existing' = rnd() < 0.5 ? 'start-new' : 'restart-existing';
    const killDelay = 20 + Math.floor(rnd() * 20); // 20..39ms
    const opDelay = 1 + Math.floor(rnd() * 12); // 1..12ms

    const ctx: Ctx = { spawnCalls: [], killDelay };
    const master = new MasterOrchestrator();
    stub(master, ctx);
    openMasters.push({ master, ctx });

    await master.startApp(makeConfig('a'));
    const spawnsBefore = ctx.spawnCalls.length;
    expect(spawnsBefore).toBe(2);

    // SIGTERM arrives; the control server is still accepting commands.
    const shutdownDone = master.shutdown('SIGTERM');

    await Bun.sleep(opDelay);

    // A control command lands inside the shutdown window. Rejecting it (sync
    // throw or rejected promise) is a perfectly valid outcome — what must never
    // happen is that it succeeds and leaves live workers behind.
    const inflight = (async () =>
      op === 'start-new' ? master.startApp(makeConfig('b')) : master.restartApp('a'))().then(
      () => undefined,
      () => undefined,
    );

    await shutdownDone;
    await inflight;

    const live = liveApps(master);
    const spawnedDuringShutdown = ctx.spawnCalls.slice(spawnsBefore);

    if (live.length > 0 || spawnedDuringShutdown.length > 0) {
      failures.push(
        `seed=${seed} op=${op} killDelay=${killDelay} opDelay=${opDelay} ` +
          `live=[${live.join(',')}] spawnedDuringShutdown=[${spawnedDuringShutdown.join(',')}]`,
      );
    }
  }

  if (failures.length > 0) {
    console.error('INV-SHUTDOWN-01 violations:\n  ' + failures.join('\n  '));
  }

  expect(failures).toEqual([]);
});
