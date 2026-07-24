// ---------------------------------------------------------------------------
// H28 – heartbeat staleness must respect the configured readyTimeout
// ---------------------------------------------------------------------------
//
// Invariant under test:
//   A worker that is still inside its configured `readyTimeout` window (state
//   'starting', has not yet called bunpilotReady()) must NOT be declared
//   heartbeat-stale — because the SDK only starts emitting heartbeats from
//   inside bunpilotReady() (src/sdk/worker.ts:33-37).
//
// Today `startWorkerMonitors` (src/core/worker-launch.ts:64 -> :182-195) arms
// the heartbeat monitor at LAUNCH time, and `startHeartbeatMonitor`
// (src/health/checker.ts:213) stamps `monitorStartedAt = Date.now()` as the
// staleness baseline. `isHeartbeatStale` then compares against the hardcoded
// HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD = 30_000 ms, with no knowledge
// of `readyTimeout` (validator allows 1_000..300_000, src/config/validator.ts:94).
//
// So an app with `readyTimeout: 120_000` that legitimately takes 60s to boot is
// declared stale at t=30_000; the monitor tick calls onStale, which sees
// state==='starting' and calls scheduleRestart -> SIGTERM on a still-booting
// process -> relaunch -> fresh baseline -> stale again 30s later. Because this
// is a 'stale' restart and not a crash, CrashRecovery never counts it and never
// reaches 'give-up': the loop is infinite.
//
// This test drives the REAL HealthChecker through the real MasterOrchestrator
// launch wiring (only the I/O collaborators — spawn/kill/log piping — are
// stubbed) and asserts the predicate that the monitor tick evaluates verbatim
// (`if (this.isHeartbeatStale(...)) onStale(...)`, checker.ts:215-219).
// ---------------------------------------------------------------------------

import { afterEach, expect, setSystemTime, test } from 'bun:test';
import type { AppConfig, WorkerMessage } from '../../src/config/types';
import { HEARTBEAT_INTERVAL, HEARTBEAT_MISS_THRESHOLD } from '../../src/constants';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';
import type { HealthChecker } from '../../src/health/checker';

/** Deterministic PRNG so any failure is reproducible from its seed. */
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

function makeConfig(name: string, readyTimeout: number): AppConfig {
  return {
    name,
    script: 'server.ts',
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

interface Harness {
  master: MasterOrchestrator;
  checker: HealthChecker;
  /** Deliver the exact IPC pair `bunpilotReady()` sends: 'ready' + 'heartbeat'. */
  sendReady: (workerId: number) => void;
  quiesce: () => void;
}

/** Replace only the I/O collaborators; keep the real HealthChecker + launch path. */
function harness(name: string): Harness {
  const master = new MasterOrchestrator();
  const m = master as unknown as Record<string, any>;
  const inbox = new Map<number, (wid: number, msg: WorkerMessage) => void>();
  let nextPid = 9000;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (wid: number, msg: WorkerMessage) => void,
    ): SpawnedWorker {
      // A slow-boot worker: it does NOT call bunpilotReady() yet, so no
      // 'ready' and (per the SDK) no 'heartbeat' messages are sent.
      inbox.set(workerId, onMessage);
      return {
        proc: {} as never,
        pid: nextPid++,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      };
    },
    async killWorker() {
      return 'exited' as const;
    },
    isRunning() {
      return true;
    },
  };
  m.logManager = { pipeOutput() {}, closeAll() {}, closeApp: async () => {} };
  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);

  return {
    master,
    checker: m.healthChecker as HealthChecker,
    sendReady: (workerId) => {
      const onMessage = inbox.get(workerId);
      if (!onMessage) return;
      // src/sdk/worker.ts:33-37 — bunpilotReady() sends 'ready' then a first
      // heartbeat, and only then starts the heartbeat interval.
      onMessage(workerId, { type: 'ready' });
      onMessage(workerId, { type: 'heartbeat', uptime: 1 });
    },
    quiesce: () => {
      const app = m.apps.get(name);
      if (app) {
        app.stopping = true;
        for (const t of app.readyTimers.values()) clearTimeout(t);
        app.readyTimers.clear();
        for (const t of app.stableTimers.values()) clearTimeout(t);
        app.stableTimers.clear();
      }
      (m.healthChecker as HealthChecker).stopAll();
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  setSystemTime();
});

test('H28: a worker still inside its readyTimeout must not be heartbeat-stale', async () => {
  const SEED = 28_072_026;
  const rand = mulberry32(SEED);
  const failures: string[] = [];
  const BASE = 1_760_000_000_000;

  // readyTimeout values that the validator accepts (1_000..300_000) and that
  // exceed the hardcoded 30s heartbeat grace window.
  const readyTimeouts = [
    45_000,
    120_000,
    300_000,
    40_000 + Math.floor(rand() * 200_000),
    40_000 + Math.floor(rand() * 200_000),
  ];

  for (let iter = 0; iter < readyTimeouts.length; iter++) {
    const readyTimeout = readyTimeouts[iter]!;
    const name = `h28-app-${iter}`;
    setSystemTime(new Date(BASE));

    const h = harness(name);
    cleanups.push(h.quiesce);
    await h.master.startApp(makeConfig(name, readyTimeout));

    // Probe the whole legitimate boot window: every offset strictly below
    // readyTimeout is a moment where the worker is still allowed to be booting.
    const probes = [
      1,
      HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD, // exactly 30s: first bite
      HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD + 1,
      Math.floor(readyTimeout / 2),
      readyTimeout - 1,
      ...Array.from({ length: 4 }, () => 1 + Math.floor(rand() * (readyTimeout - 1))),
    ].sort((a, b) => a - b);

    for (const elapsed of probes) {
      setSystemTime(new Date(BASE + elapsed));
      if (h.checker.isHeartbeatStale(0, name)) {
        failures.push(
          `seed=${SEED} iter=${iter} readyTimeout=${readyTimeout}ms: worker 0 declared ` +
            `heartbeat-stale after only ${elapsed}ms — it is still 'starting' and has ` +
            `${readyTimeout - elapsed}ms of its configured readyTimeout left. The next ` +
            `monitor tick calls onStale -> scheduleRestart on a still-booting process.`,
        );
        break;
      }
    }

    // Positive control: once the worker HAS reported ready (and beat once), the
    // SDK is emitting heartbeats; 30s of silence then legitimately means stale.
    // This proves the assertion above is not vacuous — staleness detection for a
    // live worker must keep working.
    setSystemTime(new Date(BASE + 1));
    h.sendReady(0);
    setSystemTime(new Date(BASE + 1 + HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD));
    expect(h.checker.isHeartbeatStale(0, name)).toBe(true);

    h.quiesce();
    setSystemTime();
  }

  expect(failures).toEqual([]);
});
