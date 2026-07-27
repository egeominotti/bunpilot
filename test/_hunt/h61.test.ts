// ---------------------------------------------------------------------------
// H61 – shutdown vs. in-flight restartWorker
// ---------------------------------------------------------------------------
//
// Invariant (AGENTS.md): shutdown is authoritative — once master.shutdown()
// has resolved, nothing may spawn a new worker process or arm a new
// health/heartbeat timer for an app.
//
// restartWorker() parks on `await sleep(PORT_RELEASE_DELAY)` (500 ms) before
// relaunching. Its post-await guard only tests `managed.stopping`, and
// stopAppUnlocked resets `managed.stopping = false` in its `finally`, so by the
// time the sleeping restart resumes the guard is already disarmed: it spawns a
// brand-new child and re-arms a heartbeat monitor AFTER shutdown finished.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

// --- deterministic PRNG (mulberry32) --------------------------------------
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Ctx {
  spawnCalls: number[];
  exit: Map<number, (wid: number, code: number | null, sig: string | null) => void>;
  message: Map<number, (wid: number, msg: unknown) => void>;
  nextPid: number;
}

function emptyStream(): ReadableStream {
  return new ReadableStream({
    start(c) {
      c.close();
    },
  });
}

/** Stub only the OS-touching collaborators; HealthChecker stays REAL. */
function stub(master: MasterOrchestrator, ctx: Ctx): void {
  const m = master as unknown as Record<string, unknown>;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (wid: number, msg: unknown) => void,
      onExit: (wid: number, code: number | null, sig: string | null) => void,
    ): SpawnedWorker {
      ctx.spawnCalls.push(workerId);
      ctx.message.set(workerId, onMessage);
      ctx.exit.set(workerId, onExit);
      return {
        proc: {} as never,
        pid: ctx.nextPid++,
        stdout: emptyStream(),
        stderr: emptyStream(),
      };
    },
    async killWorker() {
      return 'exited' as const;
    },
    // The crashed child is already gone, so restartWorker skips the kill and
    // goes straight to the port-release sleep.
    isRunning() {
      return false;
    },
  };

  m.logManager = {
    pipeOutput() {},
    async closeAll() {},
  };

  m.workerHandler = new WorkerHandler(
    m.processManager as never,
    m.crashRecovery as never,
    m.lifecycle as never,
  );
}

function makeConfig(name: string, port: number, backoffInitial: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 1,
    maxRestarts: 10,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 1_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 60_000,
    backoff: { initial: backoffInitial, multiplier: 1, max: backoffInitial },
    port,
    clustering: {
      enabled: false,
      strategy: 'auto',
      rollingRestart: { batchSize: 1, batchDelay: 0 },
    },
  };
}

test('shutdown() is authoritative: no worker is spawned and no heartbeat timer armed after it resolves', async () => {
  const rand = prng(0x51d61);

  for (let iteration = 0; iteration < 5; iteration++) {
    const seed = Math.floor(rand() * 1_000_000);
    const backoffInitial = 10 + Math.floor(rand() * 30); // 10..39 ms
    const port = 41_000 + Math.floor(rand() * 10_000);
    const name = `h61-${seed}`;

    const ctx: Ctx = { spawnCalls: [], exit: new Map(), message: new Map(), nextPid: 90_000 };
    const master = new MasterOrchestrator();
    stub(master, ctx);
    const healthChecker = (master as unknown as { healthChecker: { stopAll(): void } })
      .healthChecker;
    const heartbeatTimers = (healthChecker as unknown as { heartbeatTimers: Map<string, unknown> })
      .heartbeatTimers;

    try {
      await master.startApp(makeConfig(name, port, backoffInitial));
      expect(ctx.spawnCalls).toEqual([0]);

      // Worker becomes ready, then crashes.
      ctx.message.get(0)?.(0, { type: 'ready' });
      ctx.exit.get(0)?.(0, 1, null);

      // Let the backoff timer fire; restartWorker is now parked inside its
      // 500 ms PORT_RELEASE_DELAY sleep.
      await sleep(backoffInitial + 40);

      await master.shutdown('SIGTERM');

      // Everything after this point happens strictly AFTER shutdown resolved.
      const spawnsAtShutdown = ctx.spawnCalls.length;
      await sleep(600);

      expect({
        seed,
        spawnsAfterShutdown: ctx.spawnCalls.length - spawnsAtShutdown,
        heartbeatTimersAfterShutdown: [...heartbeatTimers.keys()],
      }).toEqual({ seed, spawnsAfterShutdown: 0, heartbeatTimersAfterShutdown: [] });
    } finally {
      healthChecker.stopAll();
      await master.shutdown('SIGTERM').catch(() => {});
    }
  }
}, 20_000);
