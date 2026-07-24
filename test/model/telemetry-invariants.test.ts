// ---------------------------------------------------------------------------
// bunpilot – Model-based invariants for the deep-telemetry ingestion pipeline
// ---------------------------------------------------------------------------
//
// A seeded PRNG drives a long sequence of adversarial worker->master metrics
// payloads (NaN / Infinity / negatives / hostile extra keys / oversized object
// arrays) through the REAL WorkerHandler.handleMessage -> toAppStatus path — the
// exact path that re-serialises worker state into the bounded, sometimes
// unauthenticated control plane. After every operation the invariants below
// must hold; a failing seed is printed for static reproduction.
//
// Invariants (AGENTS.md "untrusted input" + telemetry contract):
//   T1  Every numeric field retained by the master is FINITE, so JSON.stringify
//       can never turn it into `null` and crash a `.toFixed()` consumer (h69).
//   T2  Only explicitly-named fields enter worker state — no hostile key from
//       the payload is ever copied through (h48).
//   T3  Telemetry sub-objects stay bounded and sign-correct: heapGrowthBytes is
//       finite (any sign); every other number is finite and >= 0; the object
//       -type census is capped.
//   T4  The IPC validator never ACCEPTS a payload with a non-finite required
//       field, and never REJECTS a fully well-formed one.
//   T5  A status snapshot round-trips through JSON with no numeric field lost,
//       and never carries a raw env secret value.
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
// Deterministic PRNG (LCG) — a failure is reproducible from its printed seed.
// ---------------------------------------------------------------------------

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function integer(next: () => number, maxExclusive: number): number {
  return Math.floor(next() * maxExclusive);
}

function pick<T>(next: () => number, arr: readonly T[]): T {
  return arr[integer(next, arr.length)] as T;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAX_RETAINED_OBJECT_TYPES = 32;

const HOSTILE_NUMBERS: readonly unknown[] = [
  0,
  1,
  42,
  -1,
  -999_999,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  1.5e308,
  'not-a-number',
  null,
  undefined,
  {},
  [],
];

const HOSTILE_KEYS = ['__proto__', 'constructor', 'prototype', 'evil', 'leak', 'toString'];

const ALLOWED_MEMORY_KEYS = new Set([
  'rss',
  'heapTotal',
  'heapUsed',
  'external',
  'arrayBuffers',
  'timestamp',
]);
const ALLOWED_HEAP_KEYS = new Set([
  'heapSize',
  'heapCapacity',
  'extraMemory',
  'objectCount',
  'protectedObjectCount',
  'globalObjectCount',
  'usedHeapSize',
  'totalHeapSize',
  'heapSizeLimit',
  'mallocedMemory',
  'peakMallocedMemory',
  'nativeContexts',
  'detachedContexts',
  'arrayBuffers',
  'topObjectTypes',
]);
const ALLOWED_GC_KEYS = new Set([
  'heapGrowthBytes',
  'allocationRateBytesPerSec',
  'reclaimedBytes',
  'inferredCollections',
  'heapUtilization',
  'compileTimeMs',
]);
const ALLOWED_STACK_KEYS = new Set([
  'eventLoopLagMs',
  'eventLoopLagMaxMs',
  'eventLoopLagP99Ms',
  'eventLoopUtilization',
  'activeResources',
  'callStackDepth',
]);

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'model-app',
    script: 'app.ts',
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    ...overrides,
  };
}

function makeWorker(id: number): WorkerInfo {
  return {
    id,
    pid: 1_000 + id,
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
  };
}

function makeManagedApp(workers: WorkerInfo[], config: AppConfig): ManagedApp {
  return {
    config,
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
      throw new Error('spawnWorker not used on the metrics path');
    },
    killWorker: async () => 'exited' as const,
    isRunning: () => false,
  } as unknown as ProcessManager;
}

function makeHandler(): WorkerHandler {
  return new WorkerHandler(mockProcessManager(), new CrashRecovery(), new WorkerLifecycle());
}

// ---------------------------------------------------------------------------
// Adversarial payload generation
// ---------------------------------------------------------------------------

function hostileNumber(next: () => number): unknown {
  return pick(next, HOSTILE_NUMBERS);
}

function objWithHostileKeys(
  next: () => number,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  const injections = integer(next, 3);
  for (let i = 0; i < injections; i++) {
    out[pick(next, HOSTILE_KEYS)] = hostileNumber(next);
  }
  return out;
}

function hostileMetricsPayload(next: () => number): unknown {
  const mem = objWithHostileKeys(next, {
    rss: hostileNumber(next),
    heapTotal: hostileNumber(next),
    heapUsed: hostileNumber(next),
    external: hostileNumber(next),
    arrayBuffers: hostileNumber(next),
  });
  const cpu = objWithHostileKeys(next, {
    user: hostileNumber(next),
    system: hostileNumber(next),
  });

  const payload: Record<string, unknown> = { memory: mem, cpu };

  if (next() < 0.8) {
    const typeCount = integer(next, 80); // sometimes far above the retained cap
    const topObjectTypes = Array.from({ length: typeCount }, () => ({
      type: pick(next, ['Function', 'string', 'Structure', 'Array', 'evilType', '']),
      count: hostileNumber(next),
    }));
    payload.heap = objWithHostileKeys(next, {
      heapSize: hostileNumber(next),
      heapCapacity: hostileNumber(next),
      extraMemory: hostileNumber(next),
      objectCount: hostileNumber(next),
      protectedObjectCount: hostileNumber(next),
      globalObjectCount: hostileNumber(next),
      usedHeapSize: hostileNumber(next),
      totalHeapSize: hostileNumber(next),
      heapSizeLimit: hostileNumber(next),
      mallocedMemory: hostileNumber(next),
      peakMallocedMemory: hostileNumber(next),
      nativeContexts: hostileNumber(next),
      detachedContexts: hostileNumber(next),
      arrayBuffers: hostileNumber(next),
      topObjectTypes,
    });
  }
  if (next() < 0.8) {
    payload.gc = objWithHostileKeys(next, {
      heapGrowthBytes: hostileNumber(next),
      allocationRateBytesPerSec: hostileNumber(next),
      reclaimedBytes: hostileNumber(next),
      inferredCollections: hostileNumber(next),
      heapUtilization: hostileNumber(next),
      compileTimeMs: hostileNumber(next),
    });
  }
  if (next() < 0.8) {
    payload.stack = objWithHostileKeys(next, {
      eventLoopLagMs: hostileNumber(next),
      eventLoopLagMaxMs: hostileNumber(next),
      eventLoopLagP99Ms: hostileNumber(next),
      eventLoopUtilization: hostileNumber(next),
      activeResources: hostileNumber(next),
      callStackDepth: hostileNumber(next),
    });
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertAllNumbersFinite(value: unknown, path: string, seed: number): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`T1 violated (seed=${seed}): non-finite number at ${path} = ${value}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      assertAllNumbersFinite(v, `${path}[${i}]`, seed);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertAllNumbersFinite(v, `${path}.${k}`, seed);
  }
}

function assertKeysSubsetOf(
  obj: Record<string, unknown>,
  allowed: Set<string>,
  where: string,
  seed: number,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(`T2 violated (seed=${seed}): hostile key "${key}" leaked into ${where}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('telemetry ingestion — model-based invariants', () => {
  test('hostile metrics payloads never corrupt orchestrator state (T1/T2/T3)', () => {
    for (let seed = 1; seed <= 64; seed++) {
      const next = random(seed);
      const workers = [makeWorker(0), makeWorker(1)];
      const managed = makeManagedApp(workers, makeConfig());
      const handler = makeHandler();

      for (let step = 0; step < 200; step++) {
        const wid = integer(next, workers.length);
        const payload = hostileMetricsPayload(next);
        handler.handleMessage(managed, wid, {
          type: 'metrics',
          payload,
        } as unknown as WorkerMessage);

        const worker = workers[wid] as WorkerInfo;

        // T1 — nothing retained is non-finite.
        assertAllNumbersFinite(worker.memory, 'worker.memory', seed);
        assertAllNumbersFinite(worker.cpu, 'worker.cpu', seed);
        assertAllNumbersFinite(worker.telemetry, 'worker.telemetry', seed);

        // T1 — the CPU percentage a consumer will .toFixed() is finite and >= 0.
        if (worker.cpu) {
          expect(Number.isFinite(worker.cpu.percentage)).toBe(true);
          expect(worker.cpu.percentage).toBeGreaterThanOrEqual(0);
        }

        // T2 — only known keys entered state (no __proto__ / evil / etc.).
        if (worker.memory)
          assertKeysSubsetOf(
            worker.memory as unknown as Record<string, unknown>,
            ALLOWED_MEMORY_KEYS,
            'worker.memory',
            seed,
          );
        const t = worker.telemetry;
        if (t) {
          assertKeysSubsetOf(
            t.heap as unknown as Record<string, unknown>,
            ALLOWED_HEAP_KEYS,
            'telemetry.heap',
            seed,
          );
          assertKeysSubsetOf(
            t.gc as unknown as Record<string, unknown>,
            ALLOWED_GC_KEYS,
            'telemetry.gc',
            seed,
          );
          assertKeysSubsetOf(
            t.stack as unknown as Record<string, unknown>,
            ALLOWED_STACK_KEYS,
            'telemetry.stack',
            seed,
          );

          // T3 — bounds + signs.
          expect(t.heap.topObjectTypes.length).toBeLessThanOrEqual(MAX_RETAINED_OBJECT_TYPES);
          for (const entry of t.heap.topObjectTypes) {
            expect(typeof entry.type).toBe('string');
            expect(entry.count).toBeGreaterThanOrEqual(0);
          }
          expect(t.gc.reclaimedBytes).toBeGreaterThanOrEqual(0);
          expect(t.gc.allocationRateBytesPerSec).toBeGreaterThanOrEqual(0);
          expect(t.gc.inferredCollections).toBeGreaterThanOrEqual(0);
          expect(t.stack.eventLoopLagMs).toBeGreaterThanOrEqual(0);
          expect(t.stack.activeResources).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  test('IPC validator is sound and complete for metrics payloads (T4)', () => {
    for (let seed = 1; seed <= 96; seed++) {
      const next = random(seed);

      // Soundness: a hostile payload that the validator ACCEPTS must have every
      // required numeric field finite.
      const hostile = hostileMetricsPayload(next);
      const msg = { type: 'metrics', payload: hostile };
      if (isValidWorkerMessage(msg)) {
        const p = hostile as { memory: Record<string, number>; cpu: Record<string, number> };
        for (const k of ['rss', 'heapTotal', 'heapUsed', 'external']) {
          expect(Number.isFinite(p.memory[k])).toBe(true);
          expect(p.memory[k]).toBeGreaterThanOrEqual(0);
        }
        for (const k of ['user', 'system']) {
          expect(Number.isFinite(p.cpu[k])).toBe(true);
        }
      }

      // Completeness: a fully well-formed payload is always accepted.
      const clean = {
        type: 'metrics',
        payload: {
          memory: { rss: 10, heapTotal: 20, heapUsed: 5, external: 1, arrayBuffers: 2 },
          cpu: { user: 100 + integer(next, 1_000), system: integer(next, 1_000) },
          heap: {
            heapSize: 1,
            heapCapacity: 2,
            extraMemory: 0,
            objectCount: 3,
            protectedObjectCount: 0,
            globalObjectCount: 1,
            usedHeapSize: 1,
            totalHeapSize: 2,
            heapSizeLimit: 100,
            mallocedMemory: 1,
            peakMallocedMemory: 2,
            nativeContexts: 1,
            detachedContexts: 0,
            arrayBuffers: 2,
            topObjectTypes: [{ type: 'Function', count: 9 }],
          },
          gc: {
            heapGrowthBytes: -50,
            allocationRateBytesPerSec: 0,
            reclaimedBytes: 50,
            inferredCollections: 1,
            heapUtilization: 0.01,
            compileTimeMs: 3,
          },
          stack: {
            eventLoopLagMs: 0.5,
            eventLoopLagMaxMs: 1,
            eventLoopLagP99Ms: 0.9,
            eventLoopUtilization: 0.1,
            activeResources: 4,
            callStackDepth: 3,
          },
        },
      };
      expect(isValidWorkerMessage(clean)).toBe(true);

      // A single non-finite required field must be rejected (fail closed).
      const bad = structuredClone(clean);
      (bad.payload.memory as { rss: number }).rss = Number.NaN;
      expect(isValidWorkerMessage(bad)).toBe(false);

      // A negative heapGrowthBytes is legal (net reclaim); a negative
      // reclaimedBytes is not.
      const negGrowth = structuredClone(clean);
      (negGrowth.payload.gc as { heapGrowthBytes: number }).heapGrowthBytes = -123;
      expect(isValidWorkerMessage(negGrowth)).toBe(true);
      const negReclaim = structuredClone(clean);
      (negReclaim.payload.gc as { reclaimedBytes: number }).reclaimedBytes = -1;
      expect(isValidWorkerMessage(negReclaim)).toBe(false);
    }
  });

  test('status snapshots survive JSON round-trip and never leak env secrets (T5)', () => {
    for (let seed = 1; seed <= 48; seed++) {
      const next = random(seed);
      const secret = `SUPERSECRET-${seed}-${integer(next, 1_000_000)}`;
      const config = makeConfig({
        name: `app-${seed}`,
        env: { DATABASE_URL: `postgres://u:${secret}@db/x`, NODE_ENV: 'production' },
      });
      const workers = [makeWorker(0), makeWorker(1)];
      const managed = makeManagedApp(workers, config);
      const handler = makeHandler();

      for (let step = 0; step < 40; step++) {
        const wid = integer(next, workers.length);
        handler.handleMessage(managed, wid, {
          type: 'metrics',
          payload: hostileMetricsPayload(next),
        } as unknown as WorkerMessage);
      }

      const status = toAppStatus(managed);
      const serialised = JSON.stringify(status);

      // T5a — no numeric field became null (i.e. everything was finite).
      const parsed = JSON.parse(serialised);
      assertAllNumbersFinite(parsed, 'status', seed);
      for (const w of parsed.workers) {
        if (w.cpu) expect(w.cpu.percentage).not.toBeNull();
        if (w.telemetry) {
          expect(w.telemetry.gc.heapUtilization).not.toBeNull();
          expect(w.telemetry.stack.eventLoopLagMs).not.toBeNull();
        }
      }

      // T5b — the raw env secret is never echoed into a snapshot.
      if (serialised.includes(secret)) {
        throw new Error(`T5 violated (seed=${seed}): env secret leaked into status snapshot`);
      }
      expect(serialised).not.toContain(secret);
      expect(status.config.script).toBe('app.ts');
    }
  });
});
