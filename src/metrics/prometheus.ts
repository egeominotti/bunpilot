// ---------------------------------------------------------------------------
// bunpilot – Prometheus Exposition Format
// ---------------------------------------------------------------------------

import type { WorkerState, WorkerTelemetry } from '../config/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Latest per-worker metrics sample fed into the exposition format. */
export interface WorkerMetricsData {
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers?: number;
  };
  cpuPercent: number;
  eventLoopLag?: number;
  activeHandles?: number;
  timestamp: number;
  /** Deep runtime telemetry (heap / GC / stack), when the worker reports it. */
  telemetry?: WorkerTelemetry | null;
  custom?: Record<string, number>;
}

export interface AppMetricsInput {
  appName: string;
  workers: AppWorkerMetrics[];
}

export interface AppWorkerMetrics {
  workerId: number;
  metrics: WorkerMetricsData | null;
  restartCount: number;
  uptime: number;
  state: WorkerState;
}

// ---------------------------------------------------------------------------
// Metric descriptors
// ---------------------------------------------------------------------------

interface MetricDescriptor {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
}

const PER_WORKER_METRICS: MetricDescriptor[] = [
  {
    name: 'bunpilot_worker_memory_rss_bytes',
    help: 'Resident set size of the worker process in bytes',
    type: 'gauge',
  },
  {
    name: 'bunpilot_worker_memory_heap_used_bytes',
    help: 'V8 heap memory used by the worker process in bytes',
    type: 'gauge',
  },
  {
    name: 'bunpilot_worker_cpu_percent',
    help: 'CPU usage of the worker process as a percentage',
    type: 'gauge',
  },
  {
    name: 'bunpilot_worker_restarts_total',
    help: 'Total number of restarts for the worker',
    type: 'counter',
  },
  {
    name: 'bunpilot_worker_uptime_seconds',
    help: 'Uptime of the worker process in seconds',
    type: 'gauge',
  },
];

// -- Deep telemetry: one line per live worker, extracted from WorkerTelemetry --

interface TelemetryDescriptor extends MetricDescriptor {
  extract: (t: WorkerTelemetry) => number;
}

const TELEMETRY_METRICS: TelemetryDescriptor[] = [
  // Heap
  {
    name: 'bunpilot_worker_heap_size_bytes',
    help: 'Live JavaScriptCore heap bytes',
    type: 'gauge',
    extract: (t) => t.heap.heapSize,
  },
  {
    name: 'bunpilot_worker_heap_capacity_bytes',
    help: 'Reserved JavaScriptCore heap bytes',
    type: 'gauge',
    extract: (t) => t.heap.heapCapacity,
  },
  {
    name: 'bunpilot_worker_heap_limit_bytes',
    help: 'Hard heap size limit before OOM',
    type: 'gauge',
    extract: (t) => t.heap.heapSizeLimit,
  },
  {
    name: 'bunpilot_worker_heap_object_count',
    help: 'Total live objects on the heap',
    type: 'gauge',
    extract: (t) => t.heap.objectCount,
  },
  {
    name: 'bunpilot_worker_heap_array_buffers_bytes',
    help: 'ArrayBuffer/SharedArrayBuffer bytes',
    type: 'gauge',
    extract: (t) => t.heap.arrayBuffers,
  },
  {
    name: 'bunpilot_worker_heap_native_contexts',
    help: 'Number of native contexts (realms)',
    type: 'gauge',
    extract: (t) => t.heap.nativeContexts,
  },
  {
    name: 'bunpilot_worker_heap_detached_contexts',
    help: 'Number of detached contexts (leak signal when > 0)',
    type: 'gauge',
    extract: (t) => t.heap.detachedContexts,
  },
  // GC (derived)
  {
    name: 'bunpilot_worker_gc_heap_growth_bytes',
    help: 'Net heap growth since the previous sample (negative = reclaim)',
    type: 'gauge',
    extract: (t) => t.gc.heapGrowthBytes,
  },
  {
    name: 'bunpilot_worker_gc_allocation_rate_bytes',
    help: 'Estimated allocation rate in bytes/sec',
    type: 'gauge',
    extract: (t) => t.gc.allocationRateBytesPerSec,
  },
  {
    name: 'bunpilot_worker_gc_reclaimed_bytes',
    help: 'Bytes reclaimed since the previous sample',
    type: 'gauge',
    extract: (t) => t.gc.reclaimedBytes,
  },
  {
    name: 'bunpilot_worker_gc_collections_total',
    help: 'GC cycles inferred from heap-size drops (best-effort)',
    type: 'counter',
    extract: (t) => t.gc.inferredCollections,
  },
  {
    name: 'bunpilot_worker_gc_heap_utilization',
    help: 'usedHeapSize / heapSizeLimit in [0,1]',
    type: 'gauge',
    extract: (t) => t.gc.heapUtilization,
  },
  {
    name: 'bunpilot_worker_jit_compile_time_ms',
    help: 'Cumulative JIT compile time in ms',
    type: 'counter',
    extract: (t) => t.gc.compileTimeMs,
  },
  // Stack / event loop
  {
    name: 'bunpilot_worker_event_loop_lag_ms',
    help: 'Mean event-loop delay over the sample window in ms',
    type: 'gauge',
    extract: (t) => t.stack.eventLoopLagMs,
  },
  {
    name: 'bunpilot_worker_event_loop_lag_max_ms',
    help: 'Max event-loop delay over the sample window in ms',
    type: 'gauge',
    extract: (t) => t.stack.eventLoopLagMaxMs,
  },
  {
    name: 'bunpilot_worker_event_loop_lag_p99_ms',
    help: 'p99 event-loop delay over the sample window in ms',
    type: 'gauge',
    extract: (t) => t.stack.eventLoopLagP99Ms,
  },
  {
    name: 'bunpilot_worker_event_loop_utilization',
    help: 'Event-loop utilization in [0,1]',
    type: 'gauge',
    extract: (t) => t.stack.eventLoopUtilization,
  },
  {
    name: 'bunpilot_worker_active_resources',
    help: 'Count of active libuv/JSC resources',
    type: 'gauge',
    extract: (t) => t.stack.activeResources,
  },
  {
    name: 'bunpilot_worker_call_stack_depth',
    help: "Telemetry collector's sampling-stack depth at capture time (not application call depth)",
    type: 'gauge',
    extract: (t) => t.stack.callStackDepth,
  },
];

const HEAP_OBJECT_TYPE_METRIC: MetricDescriptor = {
  name: 'bunpilot_worker_heap_object_type_count',
  help: 'Live object count by JavaScriptCore object type (deep heap composition)',
  type: 'gauge',
};

const PER_APP_METRICS: MetricDescriptor[] = [
  {
    name: 'bunpilot_app_workers_online',
    help: 'Number of workers in online state',
    type: 'gauge',
  },
  {
    name: 'bunpilot_app_workers_errored',
    help: 'Number of workers in errored state',
    type: 'gauge',
  },
];

const MASTER_METRICS: MetricDescriptor[] = [
  {
    name: 'bunpilot_master_uptime_seconds',
    help: 'Uptime of the bunpilot master process in seconds',
    type: 'gauge',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A worker whose OS process is gone must not emit per-worker liveness gauges. */
const TERMINAL_STATES: ReadonlySet<WorkerState> = new Set<WorkerState>([
  'stopped',
  'errored',
  'crashed',
]);

function isLive(state: WorkerState): boolean {
  return !TERMINAL_STATES.has(state);
}

/** Liveness priority for choosing which worker owns a shared label. */
const STATE_PRIORITY: Record<WorkerState, number> = {
  online: 6,
  draining: 5,
  starting: 4,
  spawning: 3,
  stopping: 2,
  crashed: 1,
  errored: 0,
  stopped: 0,
};

/** Keep exactly one worker per `workerId` label, preferring the most-live. */
function dedupeByLabel(workers: AppWorkerMetrics[]): AppWorkerMetrics[] {
  const best = new Map<number, AppWorkerMetrics>();
  for (const w of workers) {
    const current = best.get(w.workerId);
    if (!current || STATE_PRIORITY[w.state] > STATE_PRIORITY[current.state]) {
      best.set(w.workerId, w);
    }
  }
  return [...best.values()];
}

/** Emit only finite values so a NaN/Infinity can't corrupt the exposition. */
function safeValue(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

/** Escape label values for Prometheus text format. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Render a single metric line with labels. */
function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const pairs = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `${name}{${pairs}} ${value}`;
}

/** Render the HELP + TYPE header block for a metric family. */
function metricHeader(desc: MetricDescriptor): string {
  return `# HELP ${desc.name} ${desc.help}\n# TYPE ${desc.name} ${desc.type}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format application metrics into the Prometheus text exposition format.
 *
 * Per-worker gauges are emitted only for LIVE workers: once a worker reaches a
 * terminal state (stopped/errored/crashed) its OS process is gone, so its
 * liveness gauges and uptime must stop (h43/h561/h593) and its label pair must
 * disappear from the exposition (h54).
 *
 * @param apps  Array of per-app metric inputs.
 * @returns     Multi-line string ready to serve on `/metrics`.
 */
export function formatPrometheus(rawApps: AppMetricsInput[]): string {
  // Collapse workers that share a label (a reload replacement briefly coexists
  // with the worker it replaces on the same slot). Prometheus rejects duplicate
  // series in one scrape, so keep exactly one worker per (app, label): the most
  // live one (online first).
  const apps = rawApps.map((app) => ({ ...app, workers: dedupeByLabel(app.workers) }));
  const lines: string[] = [];

  // -- Per-worker base metrics ---------------------------------------------
  for (const desc of PER_WORKER_METRICS) {
    lines.push(metricHeader(desc));
    for (const app of apps) {
      for (const w of app.workers) {
        if (!isLive(w.state)) continue;
        const value = workerMetricValue(desc.name, w);
        if (value !== null) {
          lines.push(
            metricLine(desc.name, { app: app.appName, worker: String(w.workerId) }, value),
          );
        }
      }
    }
    lines.push('');
  }

  // -- Per-worker deep telemetry -------------------------------------------
  for (const desc of TELEMETRY_METRICS) {
    lines.push(metricHeader(desc));
    for (const app of apps) {
      for (const w of app.workers) {
        if (!isLive(w.state)) continue;
        const telemetry = w.metrics?.telemetry;
        if (!telemetry) continue;
        const value = safeValue(desc.extract(telemetry));
        if (value !== null) {
          lines.push(
            metricLine(desc.name, { app: app.appName, worker: String(w.workerId) }, value),
          );
        }
      }
    }
    lines.push('');
  }

  // -- Per-worker heap object-type census ----------------------------------
  lines.push(metricHeader(HEAP_OBJECT_TYPE_METRIC));
  for (const app of apps) {
    for (const w of app.workers) {
      if (!isLive(w.state)) continue;
      const types = w.metrics?.telemetry?.heap.topObjectTypes;
      if (!types) continue;
      // Dedup by type: a malformed/hostile payload could carry two buckets with
      // the same type, which would emit an identical (app,worker,type) series
      // twice and make Prometheus reject the whole scrape (mirrors the
      // dedupeByLabel guard on the worker label).
      const seenTypes = new Set<string>();
      for (const { type, count } of types) {
        if (seenTypes.has(type)) continue;
        seenTypes.add(type);
        const value = safeValue(count);
        if (value !== null) {
          lines.push(
            metricLine(
              HEAP_OBJECT_TYPE_METRIC.name,
              { app: app.appName, worker: String(w.workerId), type },
              value,
            ),
          );
        }
      }
    }
  }
  lines.push('');

  // -- Per-app metrics ------------------------------------------------------
  for (const desc of PER_APP_METRICS) {
    lines.push(metricHeader(desc));
    for (const app of apps) {
      lines.push(metricLine(desc.name, { app: app.appName }, appMetricValue(desc.name, app)));
    }
    lines.push('');
  }

  // -- Master metrics -------------------------------------------------------
  for (const desc of MASTER_METRICS) {
    lines.push(metricHeader(desc));
    const uptimeSeconds = parseFloat(process.uptime().toFixed(1));
    lines.push(`${desc.name} ${uptimeSeconds}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Value extractors
// ---------------------------------------------------------------------------

function workerMetricValue(metricName: string, worker: AppWorkerMetrics): number | null {
  switch (metricName) {
    case 'bunpilot_worker_memory_rss_bytes':
      return worker.metrics?.memory.rss ?? null;

    case 'bunpilot_worker_memory_heap_used_bytes':
      return worker.metrics?.memory.heapUsed ?? null;

    case 'bunpilot_worker_cpu_percent':
      return worker.metrics ? parseFloat(worker.metrics.cpuPercent.toFixed(1)) : null;

    case 'bunpilot_worker_restarts_total':
      return worker.restartCount;

    case 'bunpilot_worker_uptime_seconds':
      return parseFloat(worker.uptime.toFixed(1));

    default:
      return null;
  }
}

function appMetricValue(metricName: string, app: AppMetricsInput): number {
  switch (metricName) {
    case 'bunpilot_app_workers_online':
      return app.workers.filter((w) => w.state === 'online').length;

    case 'bunpilot_app_workers_errored':
      return app.workers.filter((w) => w.state === 'errored' || w.state === 'crashed').length;

    default:
      return 0;
  }
}
