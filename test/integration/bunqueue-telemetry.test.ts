// ---------------------------------------------------------------------------
// bunpilot – End-to-end: deep telemetry from a real managed "bunqueue" worker
// ---------------------------------------------------------------------------
//
// Spawns the bunqueue fixture as a real Bun subprocess through the production
// ProcessManager (so IPC validation runs), captures a deep-telemetry metrics
// message, and drives it through the exact pipeline the daemon uses:
//   IPC -> isValidWorkerMessage -> WorkerHandler.applyMetrics -> toAppStatus
//        -> formatPrometheus
// asserting that bunpilot analyzes the worker's heap composition, derived GC
// pressure, and event-loop / stack health in depth.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AppConfig, WorkerMessage, WorkerMetricsPayload } from '../../src/config/types';
import { toAppStatus } from '../../src/core/app-status';
import { CrashRecovery } from '../../src/core/backoff';
import { WorkerLifecycle } from '../../src/core/lifecycle';
import { ProcessManager } from '../../src/core/process-manager';
import { type ManagedApp, WorkerHandler } from '../../src/core/worker-handler';
import { isValidWorkerMessage } from '../../src/ipc/protocol';
import { type AppMetricsInput, formatPrometheus } from '../../src/metrics/prometheus';

const FIXTURE = join(import.meta.dir, '..', '..', 'fixtures', 'bunqueue-server.ts');

const pm = new ProcessManager();
const spawnedPids: number[] = [];

afterAll(async () => {
  for (const pid of spawnedPids) {
    try {
      await pm.killWorker(pid, 'SIGKILL', 1_000);
    } catch {
      // Already gone.
    }
  }
});

function makeConfig(): AppConfig {
  return {
    name: 'bunqueue',
    script: FIXTURE,
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

function makeManaged(config: AppConfig): ManagedApp {
  return {
    config,
    workers: [
      {
        id: 0,
        slot: 0,
        pid: 0,
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
        telemetry: null,
      },
    ],
    spawned: new Map(),
    startedAt: Date.now(),
    stableTimers: new Map(),
    readyTimers: new Map(),
    workerPorts: new Map(),
    launchTokens: new Map(),
    restartingWorkers: new Set(),
    stopping: false,
    nextWorkerId: 1,
  };
}

test('bunpilot collects deep heap/GC/stack telemetry from a real bunqueue worker', async () => {
  const config = makeConfig();
  const handler = new WorkerHandler(pm, new CrashRecovery(), new WorkerLifecycle());
  const managed = makeManaged(config);

  // Capture the first deep-telemetry metrics message the worker emits.
  let resolvePayload!: (p: WorkerMetricsPayload) => void;
  const gotDeep = new Promise<WorkerMetricsPayload>((resolve) => {
    resolvePayload = resolve;
  });

  const spawned = pm.spawnWorker(
    config,
    0,
    (_wid, msg: WorkerMessage) => {
      // The message already passed the production IPC validator inside
      // ProcessManager; re-assert it here as the contract the master relies on.
      expect(isValidWorkerMessage(msg)).toBe(true);
      if (msg.type === 'metrics' && msg.payload.heap && msg.payload.gc && msg.payload.stack) {
        resolvePayload(msg.payload);
      }
    },
    () => {},
  );
  spawnedPids.push(spawned.pid);
  managed.workers[0].pid = spawned.pid;

  const payload = await Promise.race([
    gotDeep,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 12_000)),
  ]);

  expect(payload, 'worker did not report deep telemetry within 12s').not.toBeNull();
  const p = payload as WorkerMetricsPayload;

  // -- Deep heap ----------------------------------------------------------
  expect(p.heap).toBeDefined();
  expect(p.heap!.heapSize).toBeGreaterThan(0);
  expect(p.heap!.heapSizeLimit).toBeGreaterThan(0);
  // The per-object-type census is present (deep composition of the JSC heap).
  expect(p.heap!.topObjectTypes.length).toBeGreaterThan(0);
  for (const entry of p.heap!.topObjectTypes) {
    expect(typeof entry.type).toBe('string');
    expect(entry.count).toBeGreaterThanOrEqual(0);
  }

  // -- Derived GC ---------------------------------------------------------
  expect(p.gc).toBeDefined();
  expect(Number.isFinite(p.gc!.heapGrowthBytes)).toBe(true);
  expect(p.gc!.heapUtilization).toBeGreaterThanOrEqual(0);
  expect(p.gc!.heapUtilization).toBeLessThanOrEqual(1);

  // -- Event-loop / stack -------------------------------------------------
  expect(p.stack).toBeDefined();
  expect(p.stack!.eventLoopLagMs).toBeGreaterThanOrEqual(0);
  expect(p.stack!.eventLoopUtilization).toBeGreaterThanOrEqual(0);
  expect(p.stack!.eventLoopUtilization).toBeLessThanOrEqual(1);

  // -- Full pipeline: store -> snapshot -> Prometheus ---------------------
  handler.handleMessage(managed, 0, { type: 'metrics', payload: p });
  const status = toAppStatus(managed);
  expect(status.workers[0].telemetry).not.toBeNull();
  expect(status.workers[0].telemetry!.heap.topObjectTypes.length).toBeGreaterThan(0);

  const metricsInput: AppMetricsInput[] = [
    {
      appName: 'bunqueue',
      workers: [
        {
          workerId: 0,
          metrics: {
            memory: {
              rss: p.memory.rss,
              heapTotal: p.memory.heapTotal,
              heapUsed: p.memory.heapUsed,
              external: p.memory.external,
              arrayBuffers: p.memory.arrayBuffers,
            },
            cpuPercent: 0,
            timestamp: Date.now(),
            telemetry: status.workers[0].telemetry,
          },
          restartCount: 0,
          uptime: 1,
          state: 'online',
        },
      ],
    },
  ];
  const exposition = formatPrometheus(metricsInput);
  expect(exposition).toContain('bunpilot_worker_heap_size_bytes{app="bunqueue",worker="0"}');
  expect(exposition).toContain('bunpilot_worker_gc_heap_utilization{app="bunqueue",worker="0"}');
  expect(exposition).toContain('bunpilot_worker_event_loop_lag_ms{app="bunqueue",worker="0"}');
  expect(exposition).toContain(
    'bunpilot_worker_heap_object_type_count{app="bunqueue",worker="0",type=',
  );
}, 20_000);
