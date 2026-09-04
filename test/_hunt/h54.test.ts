// ---------------------------------------------------------------------------
// h54 — Prometheus `worker` label cardinality must stay bounded across reloads
// ---------------------------------------------------------------------------
//
// Invariant under test:
//   The (app, worker) label pair identifies a *slot* of an app, not a process
//   generation. A zero-downtime reload replaces the process behind a slot, so
//   the set of `worker="…"` label values a long-lived daemon ever exposes for
//   an app must stay bounded by that app's instance count — it must NOT grow
//   with the number of reloads.
//
// Today `MasterOrchestrator.reloadAppUnlocked` mints a replacement id with
// `managed.nextWorkerId++` (src/core/master.ts:240) and retires the old entry,
// while `formatPrometheus` uses `worker: String(w.workerId)` as the only
// per-worker label (src/metrics/prometheus.ts:141). Every reload therefore
// publishes a brand-new set of series and permanently staleifies the previous
// ones (unbounded cardinality growth; dashboards/alerts pinned to a worker
// label silently stop matching; `bunpilot_worker_restarts_total` loses its
// history).
//
// The bound asserted below (2 * instances) is deliberately loose so that ANY
// reasonable fix passes: a stable slot label, or recycling the lowest free id
// (which can only ever alternate between two disjoint id windows while an old
// and a new generation coexist).
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import type { AppConfig, WorkerInfo, WorkerMessage } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import {
  type AppMetricsInput,
  type AppWorkerMetrics,
  formatPrometheus,
} from '../../src/metrics/prometheus';

// ---------------------------------------------------------------------------
// Deterministic PRNG
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Stub harness (same shape as test/core/master.test.ts)
// ---------------------------------------------------------------------------

interface Ctx {
  nextPid: number;
  /** Captured onMessage callbacks keyed by workerId. */
  messageCallbacks: Map<number, (wid: number, msg: WorkerMessage) => void>;
}

function emptyStream(): ReadableStream {
  return new ReadableStream({
    start(c) {
      c.close();
    },
  });
}

function stubMaster(master: MasterOrchestrator, ctx: Ctx): void {
  const m = master as any;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (wid: number, msg: WorkerMessage) => void,
      _onExit: unknown,
    ): SpawnedWorker {
      ctx.messageCallbacks.set(workerId, onMessage);
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
    isRunning() {
      return false;
    },
  };

  m.logManager = {
    pipeOutput() {},
    closeAll() {},
    async closeWorker() {},
    async closeApp() {},
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

  const { WorkerHandler } = require('../../src/core/worker-handler');
  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

function makeConfig(name: string, instances: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 5_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    clustering: {
      enabled: true,
      strategy: 'reusePort',
      rollingRestart: { batchSize: instances, batchDelay: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function managedOf(master: MasterOrchestrator, name: string): any {
  return (master as any).apps.get(name);
}

/** Deliver a `ready` IPC message to every worker that is still coming up. */
function markAllReady(master: MasterOrchestrator, ctx: Ctx, name: string): void {
  const managed = managedOf(master, name);
  if (!managed) return;
  for (const w of managed.workers as WorkerInfo[]) {
    if (w.state === 'starting' || w.state === 'spawning') {
      ctx.messageCallbacks.get(w.id)?.(w.id, { type: 'ready' } as WorkerMessage);
    }
  }
}

/** Drive a reload to completion, readying replacements as they appear. */
async function reloadAndReady(master: MasterOrchestrator, ctx: Ctx, name: string): Promise<void> {
  const promise = master.reloadApp(name);
  const pump = setInterval(() => markAllReady(master, ctx, name), 5);
  try {
    await promise;
  } finally {
    clearInterval(pump);
  }
}

/** Mirror of the private adapter in src/daemon/boot.ts (appStatusToMetricsInput). */
function toMetricsInput(master: MasterOrchestrator): AppMetricsInput[] {
  return master.listApps().map((app) => ({
    appName: app.name,
    workers: app.workers.map((w): AppWorkerMetrics => {
      // Accept a dedicated stable-slot field if a fix introduces one.
      const identity = (w as WorkerInfo & { slot?: number }).slot ?? w.id;
      return {
        workerId: identity,
        metrics: null,
        restartCount: w.restartCount,
        uptime: (Date.now() - w.startedAt) / 1000,
        state: w.state,
      };
    }),
  }));
}

const LABEL_RE = /^bunpilot_worker_[a-z_]+\{app="([^"]*)",worker="([^"]*)"\}/gm;

/** Extract every `app`/`worker` label pair present in an exposition payload. */
function labelPairs(exposition: string): Set<string> {
  const out = new Set<string>();
  LABEL_RE.lastIndex = 0;
  let match = LABEL_RE.exec(exposition);
  while (match !== null) {
    out.add(`${match[1]}|${match[2]}`);
    match = LABEL_RE.exec(exposition);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

let active: MasterOrchestrator | null = null;

afterEach(async () => {
  if (!active) return;
  const master = active;
  active = null;
  const m = master as any;
  for (const managed of m.apps.values()) {
    m.workerHandler.cleanupApp(managed);
  }
  await master.shutdown('SIGTERM');
  for (const managed of m.apps.values()) {
    m.workerHandler.cleanupApp(managed);
  }
});

// ---------------------------------------------------------------------------
// Property: reloading never grows the exposed `worker` label cardinality
// ---------------------------------------------------------------------------

test('per-worker Prometheus label cardinality stays bounded across reloads/restarts', async () => {
  const seeds = [0xb16b00b5, 0x0badc0de, 0x5eed1234];

  for (const seed of seeds) {
    const rand = mulberry32(seed);
    const instances = 2 + Math.floor(rand() * 2); // 2 or 3
    const appName = `app-${seed.toString(16)}`;

    const ctx: Ctx = { nextPid: 5000, messageCallbacks: new Map() };
    const master = new MasterOrchestrator();
    active = master;
    stubMaster(master, ctx);

    await master.startApp(makeConfig(appName, instances));
    markAllReady(master, ctx, appName);

    const everSeen = new Set<string>();
    for (const pair of labelPairs(formatPrometheus(toMetricsInput(master)))) {
      everSeen.add(pair);
    }

    const ops: string[] = [];
    const OPS = 8;
    for (let i = 0; i < OPS; i++) {
      const op = rand() < 0.8 ? 'reload' : 'restart';
      ops.push(op);

      if (op === 'reload') {
        await reloadAndReady(master, ctx, appName);
      } else {
        await master.restartApp(appName);
      }
      markAllReady(master, ctx, appName);

      const exposition = formatPrometheus(toMetricsInput(master));
      const live = labelPairs(exposition);
      for (const pair of live) everSeen.add(pair);

      // The app never changes shape: it always exposes exactly `instances`
      // per-worker series at any instant.
      if (live.size !== instances) {
        throw new Error(
          `unexpected live series count — seed=0x${seed.toString(16)} step=${i} op=${op}: ` +
            `${live.size} != ${instances} (${[...live].join(' ')})`,
        );
      }

      // The invariant: the *cumulative* label cardinality is bounded by the
      // app's shape, not by how many times it has been reloaded.
      const bound = 2 * instances;
      if (everSeen.size > bound) {
        throw new Error(
          `label cardinality grew without bound — seed=0x${seed.toString(16)} ` +
            `instances=${instances} ops=[${ops.join(',')}] step=${i} op=${op}: ` +
            `${everSeen.size} distinct (app,worker) series after ${i + 1} operations ` +
            `(bound ${bound}); seen=${[...everSeen].join(' ')}`,
        );
      }
    }

    const m = master as any;
    for (const managed of m.apps.values()) m.workerHandler.cleanupApp(managed);
    await master.shutdown('SIGTERM');
    active = null;
  }
}, 20_000);

// ---------------------------------------------------------------------------
// Focused regression: one reload must not restamp the label set
// ---------------------------------------------------------------------------

test('a single reload keeps the same (app, worker) label set', async () => {
  const ctx: Ctx = { nextPid: 7000, messageCallbacks: new Map() };
  const master = new MasterOrchestrator();
  active = master;
  stubMaster(master, ctx);

  await master.startApp(makeConfig('web', 2));
  markAllReady(master, ctx, 'web');

  const before = labelPairs(formatPrometheus(toMetricsInput(master)));
  expect([...before].sort()).toEqual(['web|0', 'web|1']);

  await reloadAndReady(master, ctx, 'web');
  markAllReady(master, ctx, 'web');

  const after = labelPairs(formatPrometheus(toMetricsInput(master)));
  expect([...after].sort()).toEqual([...before].sort());
}, 20_000);
