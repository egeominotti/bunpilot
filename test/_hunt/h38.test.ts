// ---------------------------------------------------------------------------
// h38 – heartbeat grace must not preempt the configured readyTimeout
// ---------------------------------------------------------------------------
//
// Invariant (HC-09/HC-10 + boot contract): a worker that is still in its
// configured boot window (`readyTimeout`, legal up to 300_000 ms) must NOT be
// killed/relaunched by the heartbeat-staleness monitor. The heartbeat monitor
// is armed at launch with a hard-coded grace of
// HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD = 30_000 ms
// (src/health/checker.ts:213 + :192-196), so for every app with
// readyTimeout > 30_000 the heartbeat timer preempts the boot deadline and
// restarts a perfectly-legal slow-booting worker.
//
// Real-time trick: instead of sleeping 30 s we rewind the checker's private
// `monitorStartedAt` baseline so the very first monitor tick (t = 10 s) already
// sees > 30 s of "elapsed" time, while wall-clock elapsed is still far below
// every app's readyTimeout. Any correct fix (grace derived from readyTimeout,
// or arming the monitor only once the worker is ready) leaves the worker alone.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { HEARTBEAT_INTERVAL, HEARTBEAT_MISS_THRESHOLD } from '../../src/constants';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';

const GRACE = HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD; // 30_000

/** Deterministic PRNG (mulberry32) so a failure is always reproducible. */
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

const SEED = 0x38_38_38;
const rand = prng(SEED);

interface Spawn {
  app: string;
  workerId: number;
}

const spawnCalls: Spawn[] = [];
let nextPid = 7000;

function closedStream(): ReadableStream {
  return new ReadableStream({
    start(c) {
      c.close();
    },
  });
}

function stub(master: MasterOrchestrator): void {
  const m = master as any;
  m.processManager = {
    spawnWorker(config: AppConfig, workerId: number): SpawnedWorker {
      spawnCalls.push({ app: config.name, workerId });
      return {
        proc: {} as any,
        pid: nextPid++,
        stdout: closedStream(),
        stderr: closedStream(),
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
    async closeApp() {},
  };
  // Rebuild workerHandler against the stubbed processManager.
  const { WorkerHandler } = require('../../src/core/worker-handler');
  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

function makeConfig(name: string, readyTimeout: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
  };
}

let master: MasterOrchestrator | null = null;

afterAll(async () => {
  if (master) {
    const m = master as any;
    m.healthChecker.stopAll();
    for (const managed of m.apps.values()) {
      managed.stopping = true;
      m.workerHandler.cleanupApp(managed);
    }
    m.apps.clear();
  }
});

test(
  'slow-booting workers are not restarted before readyTimeout elapses',
  async () => {
    master = new MasterOrchestrator();
    stub(master);
    const m = master as any;

    // Property sweep: several legal readyTimeouts, all > the hard-coded grace
    // and all <= the validator ceiling (300_000).
    const apps: Array<{ name: string; readyTimeout: number }> = [];
    for (let i = 0; i < 6; i++) {
      const readyTimeout = GRACE + 1_000 + Math.floor(rand() * (300_000 - GRACE - 1_000));
      const name = `slowboot-${i}`;
      apps.push({ name, readyTimeout });
      await master.startApp(makeConfig(name, readyTimeout));
    }

    expect(spawnCalls.length).toBe(apps.length);

    const startedAt = Date.now();

    // Rewind the staleness baseline so the first monitor tick sees >30s of
    // "elapsed" heartbeat silence. If a fix arms the monitor only after the
    // worker is ready, the key is simply absent and nothing is rewound.
    const checker = m.healthChecker;
    for (const { name } of apps) {
      const key = `${name}\0${0}`;
      const base = checker.monitorStartedAt.get(key);
      if (base !== undefined) checker.monitorStartedAt.set(key, base - (GRACE + 1_500));
    }

    // Let the heartbeat monitor tick once (HEARTBEAT_INTERVAL) plus slack.
    await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL + 1_200));

    const wallElapsed = Date.now() - startedAt;

    for (const { name, readyTimeout } of apps) {
      // Sanity: we are still well inside every app's configured boot window.
      expect(wallElapsed).toBeLessThan(readyTimeout);

      const managed = m.apps.get(name);
      const worker = managed.workers[0];
      const respawns = spawnCalls.filter((s) => s.app === name).length;

      expect(
        `${name} readyTimeout=${readyTimeout} spawns=${respawns} restartCount=${worker.restartCount} (seed=${SEED})`,
      ).toBe(`${name} readyTimeout=${readyTimeout} spawns=1 restartCount=0 (seed=${SEED})`);
    }
  },
  { timeout: 25_000 },
);
