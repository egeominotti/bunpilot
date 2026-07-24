// ---------------------------------------------------------------------------
// h36 — INV-STATUS-01: after stopApp resolves, the app must not report 'running'
// ---------------------------------------------------------------------------
//
// Property: for any app started with N instances where an arbitrary subset of
// workers crashed (unexpected exit -> state 'crashed', backoff timer armed but
// not yet fired), `await master.stopApp(name)` must leave the app in a terminal
// state. stopApp kills every process, clears every backoff timer, nulls
// startedAt, stops the proxy and releases ports — so no live process and no
// timer remains that could ever move a 'crashed' worker forward.
//
// Uses a seeded deterministic PRNG so a failure prints a reproducible seed.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

// --- seeded PRNG (mulberry32) ----------------------------------------------

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

// --- stubs ------------------------------------------------------------------

interface Ctx {
  exitCallbacks: Map<number, (wid: number, code: number | null, sig: string | null) => void>;
  messageCallbacks: Map<number, (wid: number, msg: unknown) => void>;
  nextPid: number;
}

function stubMaster(master: MasterOrchestrator, ctx: Ctx): void {
  // biome-ignore lint/suspicious/noExplicitAny: test reaches into private fields
  const m = master as any;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (wid: number, msg: unknown) => void,
      onExit: (wid: number, code: number | null, sig: string | null) => void,
    ): SpawnedWorker {
      ctx.exitCallbacks.set(workerId, onExit);
      ctx.messageCallbacks.set(workerId, onMessage);
      const pid = ctx.nextPid++;
      return {
        // biome-ignore lint/suspicious/noExplicitAny: stub subprocess
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
    async killWorker() {
      return 'exited' as const;
    },
    isRunning() {
      return false;
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

  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {},
  });

  // Rebuild the handler against the stubbed process manager.
  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

function makeConfig(name: string, instances: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances,
    maxRestarts: 100, // never 'give-up' -> worker parks in 'crashed'
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    // Long backoff: the restart timer cannot fire during the test.
    backoff: { initial: 60_000, multiplier: 2, max: 120_000 },
  };
}

// ---------------------------------------------------------------------------

test('INV-STATUS-01: stopApp never leaves an app reporting running', async () => {
  const failures: string[] = [];

  for (let seed = 1; seed <= 40 && failures.length === 0; seed++) {
    const rng = makeRng(seed);
    const instances = 1 + Math.floor(rng() * 4); // 1..4
    const appName = `hunt-app-${seed}`;

    const ctx: Ctx = { exitCallbacks: new Map(), messageCallbacks: new Map(), nextPid: 9000 };
    const master = new MasterOrchestrator();
    stubMaster(master, ctx);

    try {
      await master.startApp(makeConfig(appName, instances));

      // Bring a random subset online, then crash a random non-empty subset.
      const crashed: number[] = [];
      for (let id = 0; id < instances; id++) {
        if (rng() < 0.5) {
          ctx.messageCallbacks.get(id)?.(id, { type: 'ready' });
        }
      }
      for (let id = 0; id < instances; id++) {
        if (rng() < 0.6 || (id === instances - 1 && crashed.length === 0)) {
          // Unexpected exit -> WorkerHandler.handleExit marks it 'crashed'.
          ctx.exitCallbacks.get(id)?.(id, 1, null);
          crashed.push(id);
        }
      }

      const before = master.getAppStatus(appName);
      expect(before?.workers.some((w) => w.state === 'crashed')).toBe(true);

      await master.stopApp(appName);

      const after = master.getAppStatus(appName);
      if (after === null) continue; // app removed -> nothing to report

      if (after.status === 'running' || after.startedAt !== null) {
        failures.push(
          `seed=${seed} instances=${instances} crashed=[${crashed.join(',')}] ` +
            `-> status=${after.status} startedAt=${after.startedAt} ` +
            `workerStates=${JSON.stringify(after.workers.map((w) => w.state))}`,
        );
      }
    } finally {
      await master.shutdown('SIGTERM');
    }
  }

  expect(failures).toEqual([]);
});
