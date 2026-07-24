// ---------------------------------------------------------------------------
// bunpilot – Worker SDK: deep runtime telemetry collector
// ---------------------------------------------------------------------------
//
// Runs inside a managed worker process and snapshots the JavaScriptCore runtime
// state: deep heap composition (bun:jsc heapStats + node:v8), derived GC
// pressure (Bun has no native GC event stream, so we infer it from successive
// heap samples), and event-loop / execution-stack health.
//
// Every emitted number is finite so the snapshot survives the JSON round-trip
// through the bounded control plane. Collection never throws: any probe that is
// unavailable degrades to a safe default instead of crashing the worker.
// ---------------------------------------------------------------------------

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import v8 from 'node:v8';
import type { GcMetrics, HeapMetrics, HeapObjectType, StackMetrics } from '../config/types';

// bun:jsc is Bun-only. Load it lazily so `bunpilot/worker` stays importable
// under plain Node (types-only usage) — collection degrades gracefully if it
// is absent.
interface JscModule {
  heapStats: () => {
    objectTypeCounts: Record<string, number>;
    heapSize: number;
    heapCapacity: number;
    extraMemorySize: number;
    objectCount: number;
    protectedObjectCount: number;
    globalObjectCount: number;
  };
  totalCompileTime: () => number;
}

let jscModule: JscModule | null = null;
let jscLoadStarted = false;

function loadJsc(): void {
  if (jscLoadStarted) return;
  jscLoadStarted = true;
  import('bun:jsc')
    .then((mod) => {
      jscModule = mod as unknown as JscModule;
    })
    .catch(() => {
      jscModule = null;
    });
}

/** Cap on how many object-type buckets are reported (keeps the frame bounded). */
const MAX_OBJECT_TYPES = 15;

/** How many event-loop-delay samples the histogram takes per window. */
const ELD_RESOLUTION_MS = 20;

// ---------------------------------------------------------------------------
// Collector state
// ---------------------------------------------------------------------------

export interface TelemetryState {
  eld: ReturnType<typeof monitorEventLoopDelay>;
  lastElu: ReturnType<typeof performance.eventLoopUtilization>;
  prevHeapSize: number | null;
  prevTimestamp: number | null;
  inferredCollections: number;
}

/** Create and arm the telemetry collector state. Call once per worker. */
export function createTelemetryState(): TelemetryState {
  loadJsc();
  const eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTION_MS });
  eld.enable();
  return {
    eld,
    lastElu: performance.eventLoopUtilization(),
    prevHeapSize: null,
    prevTimestamp: null,
    inferredCollections: 0,
  };
}

/** Release the event-loop-delay histogram. */
export function disposeTelemetryState(state: TelemetryState): void {
  try {
    state.eld.disable();
  } catch {
    // Already disabled.
  }
}

// ---------------------------------------------------------------------------
// Number hygiene — every field must be a finite number for IPC validation.
// ---------------------------------------------------------------------------

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function nonNeg(value: number): number {
  const v = finite(value);
  return v < 0 ? 0 : v;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export interface TelemetrySnapshot {
  arrayBuffers: number;
  heap: HeapMetrics;
  gc: GcMetrics;
  stack: StackMetrics;
}

/**
 * Take a deep telemetry snapshot. `deep` controls whether the (relatively
 * expensive) per-object-type heap census is included.
 */
export function collectTelemetry(state: TelemetryState, deep = true): TelemetrySnapshot {
  const now = Date.now();
  const mem = safeMemoryUsage();
  const v8Heap = safeV8HeapStatistics();
  const jscHeap = safeJscHeapStats();

  // -- Heap -----------------------------------------------------------------
  const heapSize = jscHeap ? nonNeg(jscHeap.heapSize) : nonNeg(v8Heap.used_heap_size);
  const topObjectTypes: HeapObjectType[] =
    deep && jscHeap ? topTypes(jscHeap.objectTypeCounts) : [];

  const heap: HeapMetrics = {
    heapSize,
    heapCapacity: jscHeap ? nonNeg(jscHeap.heapCapacity) : nonNeg(v8Heap.total_heap_size),
    extraMemory: jscHeap ? nonNeg(jscHeap.extraMemorySize) : 0,
    objectCount: jscHeap ? nonNeg(jscHeap.objectCount) : 0,
    protectedObjectCount: jscHeap ? nonNeg(jscHeap.protectedObjectCount) : 0,
    globalObjectCount: jscHeap ? nonNeg(jscHeap.globalObjectCount) : 0,
    usedHeapSize: nonNeg(v8Heap.used_heap_size),
    totalHeapSize: nonNeg(v8Heap.total_heap_size),
    heapSizeLimit: nonNeg(v8Heap.heap_size_limit),
    mallocedMemory: nonNeg(v8Heap.malloced_memory),
    peakMallocedMemory: nonNeg(v8Heap.peak_malloced_memory),
    nativeContexts: nonNeg(v8Heap.number_of_native_contexts),
    detachedContexts: nonNeg(v8Heap.number_of_detached_contexts),
    arrayBuffers: nonNeg(mem.arrayBuffers ?? 0),
    topObjectTypes,
  };

  // -- GC (derived from heap deltas) ---------------------------------------
  const elapsedSec =
    state.prevTimestamp !== null ? Math.max(0, (now - state.prevTimestamp) / 1_000) : 0;
  const growth = state.prevHeapSize !== null ? heapSize - state.prevHeapSize : 0;
  let reclaimed = 0;
  if (growth < 0) {
    reclaimed = -growth;
    state.inferredCollections += 1;
  }
  const allocationRate = growth > 0 && elapsedSec > 0 ? growth / elapsedSec : 0;
  const heapUtilization =
    heap.heapSizeLimit > 0 ? Math.min(1, heap.usedHeapSize / heap.heapSizeLimit) : 0;

  const gc: GcMetrics = {
    heapGrowthBytes: finite(growth),
    allocationRateBytesPerSec: nonNeg(allocationRate),
    reclaimedBytes: nonNeg(reclaimed),
    inferredCollections: nonNeg(state.inferredCollections),
    heapUtilization: nonNeg(heapUtilization),
    compileTimeMs: nonNeg(safeCompileTimeMs()),
  };

  state.prevHeapSize = heapSize;
  state.prevTimestamp = now;

  // -- Stack / event loop ---------------------------------------------------
  const elu = performance.eventLoopUtilization(state.lastElu);
  state.lastElu = performance.eventLoopUtilization();

  const stack: StackMetrics = {
    eventLoopLagMs: nonNeg(nsToMs(safeHistValue(() => state.eld.mean))),
    eventLoopLagMaxMs: nonNeg(nsToMs(safeHistValue(() => state.eld.max))),
    eventLoopLagP99Ms: nonNeg(nsToMs(safeHistValue(() => state.eld.percentile(99)))),
    eventLoopUtilization: nonNeg(finite(elu.utilization)),
    activeResources: nonNeg(safeActiveResources()),
    callStackDepth: nonNeg(currentStackDepth()),
  };

  // Reset the histogram so the next window measures fresh delay.
  try {
    state.eld.reset();
  } catch {
    // Older histogram without reset(); ignore.
  }

  return { arrayBuffers: heap.arrayBuffers, heap, gc, stack };
}

// ---------------------------------------------------------------------------
// Safe probes
// ---------------------------------------------------------------------------

function safeMemoryUsage(): NodeJS.MemoryUsage {
  try {
    return process.memoryUsage();
  } catch {
    return { rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 };
  }
}

type V8HeapStatistics = ReturnType<typeof v8.getHeapStatistics>;

function safeV8HeapStatistics(): V8HeapStatistics {
  try {
    return v8.getHeapStatistics();
  } catch {
    return {
      total_heap_size: 0,
      total_heap_size_executable: 0,
      total_physical_size: 0,
      total_available_size: 0,
      used_heap_size: 0,
      heap_size_limit: 0,
      malloced_memory: 0,
      peak_malloced_memory: 0,
      does_zap_garbage: 0,
      number_of_native_contexts: 0,
      number_of_detached_contexts: 0,
    } as V8HeapStatistics;
  }
}

function safeJscHeapStats(): ReturnType<JscModule['heapStats']> | null {
  if (!jscModule) return null;
  try {
    return jscModule.heapStats();
  } catch {
    return null;
  }
}

function safeCompileTimeMs(): number {
  if (!jscModule) return 0;
  try {
    return jscModule.totalCompileTime();
  } catch {
    return 0;
  }
}

function safeActiveResources(): number {
  try {
    const info = process.getActiveResourcesInfo?.();
    return Array.isArray(info) ? info.length : 0;
  } catch {
    return 0;
  }
}

function safeHistValue(read: () => number): number {
  try {
    const v = read();
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function currentStackDepth(): number {
  const stack = new Error().stack;
  if (!stack) return 0;
  // Subtract the "Error" header line; each remaining line is one frame.
  return Math.max(0, stack.split('\n').length - 1);
}

function nsToMs(ns: number): number {
  return ns / 1_000_000;
}

function topTypes(counts: Record<string, number>): HeapObjectType[] {
  return Object.entries(counts)
    .map(([type, count]) => ({ type, count: nonNeg(count) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_OBJECT_TYPES);
}
