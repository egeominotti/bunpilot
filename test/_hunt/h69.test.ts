// ---------------------------------------------------------------------------
// h69 – CPU percentage derived from IPC metrics must stay a finite number
// ---------------------------------------------------------------------------
//
// Invariant: CpuMetrics.percentage is declared `number` (src/config/types.ts)
// and every consumer calls `.toFixed()` on it unguarded. A value derived from
// untrusted IPC input must therefore remain FINITE, so that the status
// snapshot survives its JSON round-trip through the control plane
// (JSON.stringify turns Infinity/NaN into `null`).
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import type { AppConfig, WorkerInfo, WorkerMessage } from '../../src/config/types';
import { toAppStatus } from '../../src/core/app-status';
import { CrashRecovery } from '../../src/core/backoff';
import { WorkerLifecycle } from '../../src/core/lifecycle';
import type { ProcessManager } from '../../src/core/process-manager';
import { type ManagedApp, WorkerHandler } from '../../src/core/worker-handler';
import { isValidWorkerMessage } from '../../src/ipc/protocol';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeConfig(): AppConfig {
  return {
    name: 'h69-app',
    script: 'app.ts',
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
  };
}

function makeWorker(id: number): WorkerInfo {
  return {
    id,
    pid: 1000 + id,
    state: 'online',
    startedAt: Date.now(),
    readyAt: Date.now(),
    restartCount: 0,
    consecutiveCrashes: 0,
    lastCrashAt: null,
    exitCode: null,
    signalCode: null,
    memory: null,
    cpu: null,
  };
}

function makeManagedApp(workers: WorkerInfo[]): ManagedApp {
  return {
    config: makeConfig(),
    workers,
    spawned: new Map(),
    startedAt: Date.now(),
    stableTimers: new Map(),
    readyTimers: new Map(),
    workerPorts: new Map(),
    launchTokens: new Map(),
    restartingWorkers: new Set(),
    stopping: false,
    nextWorkerId: workers.length,
  };
}

function mockProcessManager(): ProcessManager {
  return {
    spawnWorker: () => {
      throw new Error('spawnWorker not mocked');
    },
    killWorker: async () => 'exited' as const,
    isRunning: () => false,
  } as unknown as ProcessManager;
}

function makeHandler(): WorkerHandler {
  return new WorkerHandler(mockProcessManager(), new CrashRecovery(), new WorkerLifecycle());
}

function metricsMsg(user: number, system: number): WorkerMessage {
  return {
    type: 'metrics',
    payload: {
      memory: { rss: 1024, heapTotal: 512, heapUsed: 256, external: 8 },
      cpu: { user, system },
    },
  };
}

/** Exactly what src/cli/commands/list.ts:71 (and status.ts:71) evaluate. */
function renderCpuCell(w: { cpu: { percentage: number } | null }): string {
  return w.cpu ? `${w.cpu.percentage.toFixed(1)}%` : '—';
}

// Deterministic 32-bit PRNG (mulberry32) — no external PBT library available.
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

describe('h69: cpu.percentage must stay finite after IPC metrics', () => {
  test('two metrics messages, second with huge-but-valid cpu counters', async () => {
    const handler = makeHandler();
    const worker = makeWorker(0);
    const managed = makeManagedApp([worker]);

    const first = metricsMsg(0, 0);
    const second = metricsMsg(1.7e308, 1.7e308);

    // Both messages pass the daemon's own IPC validator, so a worker can
    // really send them (src/core/process-manager.ts gates on this guard).
    expect(isValidWorkerMessage(first)).toBe(true);
    expect(isValidWorkerMessage(second)).toBe(true);

    handler.handleMessage(managed, 0, first);
    await Bun.sleep(5); // ensure elapsedMicros > 0
    handler.handleMessage(managed, 0, second);

    expect(worker.cpu).not.toBeNull();
    expect(Number.isFinite(worker.cpu!.percentage)).toBe(true);
  });

  test('status snapshot survives the control-plane JSON round-trip', async () => {
    const handler = makeHandler();
    const worker = makeWorker(0);
    const managed = makeManagedApp([worker]);

    handler.handleMessage(managed, 0, metricsMsg(0, 0));
    await Bun.sleep(5);
    handler.handleMessage(managed, 0, metricsMsg(1.7e308, 1.7e308));

    // ControlServer encodes AppStatus with JSON.stringify; the CLI decodes it.
    const wire = JSON.parse(JSON.stringify(toAppStatus(managed)));
    const decoded = wire.workers[0];

    expect(decoded.cpu.percentage).toBeTypeOf('number');
    // And the exact CLI expression must not throw.
    expect(() => renderCpuCell(decoded)).not.toThrow();
  });

  test('property: percentage finite for every valid metrics sequence', async () => {
    const seeds = [1, 7, 42, 1337, 90210];
    // Values that all pass isNonNegativeFiniteNumber but whose pairwise sum
    // may overflow to Infinity.
    const pool = [0, 1, 1_000, 5_000_000, 1e300, 1.7e308, Number.MAX_VALUE];

    for (const seed of seeds) {
      const rand = mulberry32(seed);
      const handler = makeHandler();
      const worker = makeWorker(0);
      const managed = makeManagedApp([worker]);

      for (let step = 0; step < 6; step++) {
        const user = pool[Math.floor(rand() * pool.length)]!;
        const system = pool[Math.floor(rand() * pool.length)]!;
        const msg = metricsMsg(user, system);
        expect(isValidWorkerMessage(msg)).toBe(true);

        handler.handleMessage(managed, 0, msg);
        await Bun.sleep(2);

        const pct = worker.cpu!.percentage;
        if (!Number.isFinite(pct)) {
          throw new Error(
            `seed=${seed} step=${step} user=${user} system=${system} -> percentage=${pct} (not finite)`,
          );
        }
        const wire = JSON.parse(JSON.stringify(toAppStatus(managed)));
        expect(wire.workers[0].cpu.percentage).toBeTypeOf('number');
      }
    }
  });
});
