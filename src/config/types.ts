// ---------------------------------------------------------------------------
// bunpilot – Configuration & Domain Types
// ---------------------------------------------------------------------------

/** Worker lifecycle states */
export type WorkerState =
  | 'spawning'
  | 'starting'
  | 'online'
  | 'draining'
  | 'stopping'
  | 'stopped'
  | 'errored'
  | 'crashed';

/** Valid state transitions */
export const TRANSITIONS: Record<WorkerState, WorkerState[]> = {
  spawning: ['starting', 'crashed'],
  starting: ['online', 'errored', 'crashed'],
  online: ['draining', 'crashed'],
  draining: ['stopping', 'crashed'],
  stopping: ['stopped', 'crashed'],
  stopped: ['spawning'],
  crashed: ['spawning', 'errored'],
  errored: ['spawning'],
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface MemoryMetrics {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  /** ArrayBuffer / SharedArrayBuffer bytes (process.memoryUsage().arrayBuffers). */
  arrayBuffers?: number;
  timestamp: number;
}

export interface CpuMetrics {
  user: number;
  system: number;
  percentage: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Deep runtime telemetry (heap / GC / stack)
// ---------------------------------------------------------------------------
//
// These describe the JavaScriptCore runtime state of a managed worker. They
// are collected in-process by the worker SDK and reported over IPC. Every
// value is a plain finite number so it survives the JSON round-trip through
// the bounded control plane. Sub-objects are optional because an old worker
// SDK (or a worker that opted out of deep telemetry) may omit them.
// ---------------------------------------------------------------------------

/** A single {objectType -> live instance count} bucket of the JSC heap. */
export interface HeapObjectType {
  type: string;
  count: number;
}

/** Deep heap composition. Merges bun:jsc heapStats, node:v8 and process. */
export interface HeapMetrics {
  /** Live bytes on the JSC heap (bun:jsc heapStats().heapSize). */
  heapSize: number;
  /** Reserved bytes on the JSC heap (heapCapacity). */
  heapCapacity: number;
  /** Off-heap bytes accounted to the heap (extraMemorySize). */
  extraMemory: number;
  /** Total live object count. */
  objectCount: number;
  /** Objects protected from GC. */
  protectedObjectCount: number;
  /** Global objects (contexts / realms). */
  globalObjectCount: number;
  /** node:v8 used_heap_size. */
  usedHeapSize: number;
  /** node:v8 total_heap_size. */
  totalHeapSize: number;
  /** node:v8 heap_size_limit — the hard ceiling before OOM. */
  heapSizeLimit: number;
  /** node:v8 malloced_memory. */
  mallocedMemory: number;
  /** node:v8 peak_malloced_memory. */
  peakMallocedMemory: number;
  /** node:v8 number_of_native_contexts. */
  nativeContexts: number;
  /** node:v8 number_of_detached_contexts — a leak signal when > 0. */
  detachedContexts: number;
  /** process.memoryUsage().arrayBuffers. */
  arrayBuffers: number;
  /** Top object types by live count — the deep composition (bounded). */
  topObjectTypes: HeapObjectType[];
}

/**
 * GC pressure. Bun/JSC exposes no native GC event stream, so these are derived
 * from successive heap samples taken by the worker itself (honest heuristic).
 */
export interface GcMetrics {
  /** heapSize delta since the previous sample (negative = net reclaim). */
  heapGrowthBytes: number;
  /** Estimated allocation rate over the sample window. */
  allocationRateBytesPerSec: number;
  /** Bytes reclaimed since the previous sample (0 when the heap only grew). */
  reclaimedBytes: number;
  /** GC cycles inferred from heapSize drops (best-effort, cumulative). */
  inferredCollections: number;
  /** usedHeapSize / heapSizeLimit in [0,1] — proximity to the OOM ceiling. */
  heapUtilization: number;
  /** bun:jsc totalCompileTime() in ms — cumulative JIT pressure (0 if N/A). */
  compileTimeMs: number;
}

/** Event-loop / execution-stack health of the worker. */
export interface StackMetrics {
  /** Mean event-loop delay over the sample window, ms. */
  eventLoopLagMs: number;
  /** Max event-loop delay over the sample window, ms. */
  eventLoopLagMaxMs: number;
  /** p99 event-loop delay over the sample window, ms. */
  eventLoopLagP99Ms: number;
  /** Event-loop utilization in [0,1] (fraction of wall time doing work). */
  eventLoopUtilization: number;
  /** Count of active libuv/JSC resources (process.getActiveResourcesInfo()). */
  activeResources: number;
  /**
   * Depth of the telemetry collector's own sampling stack at capture time. This
   * is a cheap liveness sample taken from inside the metrics timer, NOT the
   * application's synchronous call depth (measuring that would need the sampling
   * profiler). Present for completeness of the "stack" dimension.
   */
  callStackDepth: number;
}

/** The full deep-telemetry snapshot the master retains per worker. */
export interface WorkerTelemetry {
  heap: HeapMetrics;
  gc: GcMetrics;
  stack: StackMetrics;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface WorkerInfo {
  id: number;
  /**
   * Stable slot index in [0, instances) that identifies a worker position
   * across zero-downtime reloads. A reload replacement inherits the slot of the
   * worker it replaces, so the per-worker metric label set stays bounded by the
   * instance count instead of growing with every reload. Defaults to `id`.
   */
  slot?: number;
  pid: number;
  state: WorkerState;
  startedAt: number;
  readyAt: number | null;
  restartCount: number;
  consecutiveCrashes: number;
  lastCrashAt: number | null;
  exitCode: number | null;
  signalCode: string | null;
  memory: MemoryMetrics | null;
  cpu: CpuMetrics | null;
  /** Latest deep runtime telemetry (heap / GC / stack), null until reported. */
  telemetry?: WorkerTelemetry | null;
}

// ---------------------------------------------------------------------------
// IPC Messages
// ---------------------------------------------------------------------------

export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'metrics'; payload: WorkerMetricsPayload }
  | { type: 'heartbeat'; uptime: number }
  | { type: 'custom'; channel: string; data: unknown };

export interface WorkerMetricsPayload {
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers?: number;
  };
  cpu: {
    user: number;
    system: number;
  };
  eventLoopLag?: number;
  activeHandles?: number;
  activeRequests?: number;
  /** Deep heap composition (bun:jsc + node:v8 + process). */
  heap?: HeapMetrics;
  /** Derived GC pressure. */
  gc?: GcMetrics;
  /** Event-loop / stack health. */
  stack?: StackMetrics;
  custom?: Record<string, number>;
}

export type MasterMessage =
  | { type: 'shutdown'; timeout: number }
  | { type: 'ping' }
  | { type: 'collect-metrics' }
  | { type: 'config-update'; config: Partial<AppConfig> };

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

export interface HealthCheckConfig {
  enabled: boolean;
  path: string;
  interval: number;
  timeout: number;
  unhealthyThreshold: number;
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

export interface BackoffConfig {
  initial: number;
  multiplier: number;
  max: number;
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

export interface LogsConfig {
  outFile?: string;
  errFile?: string;
  maxSize: number;
  maxFiles: number;
}

// ---------------------------------------------------------------------------
// Metrics Config
// ---------------------------------------------------------------------------

export interface MetricsConfig {
  enabled: boolean;
  httpPort?: number;
  prometheus: boolean;
  collectInterval: number;
}

// ---------------------------------------------------------------------------
// Clustering
// ---------------------------------------------------------------------------

export type ClusterStrategy = 'reusePort' | 'proxy' | 'auto';

export interface ClusteringConfig {
  enabled: boolean;
  strategy: ClusterStrategy;
  rollingRestart: {
    batchSize: number;
    batchDelay: number;
  };
}

// ---------------------------------------------------------------------------
// App Config
// ---------------------------------------------------------------------------

export interface AppConfig {
  name: string;
  script: string;
  instances: number | 'max';
  port?: number;
  env?: Record<string, string>;
  cwd?: string;
  interpreter?: string;
  healthCheck?: HealthCheckConfig;
  maxRestarts: number;
  maxRestartWindow: number;
  minUptime: number;
  backoff: BackoffConfig;
  killTimeout: number;
  shutdownSignal: 'SIGTERM' | 'SIGINT';
  readyTimeout: number;
  logs?: LogsConfig;
  metrics?: MetricsConfig;
  clustering?: ClusteringConfig;
}

// ---------------------------------------------------------------------------
// Top-Level Config
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  pidFile?: string;
  socketFile?: string;
  logFile?: string;
}

export interface BunpilotConfig {
  apps: AppConfig[];
  daemon?: DaemonConfig;
}

// ---------------------------------------------------------------------------
// Control Protocol (CLI <-> Daemon)
// ---------------------------------------------------------------------------

export interface ControlRequest {
  id: string;
  cmd: string;
  args: Record<string, unknown>;
}

export interface ControlResponse {
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface ControlStreamChunk {
  id: string;
  stream: true;
  data: unknown;
  done?: boolean;
}

// ---------------------------------------------------------------------------
// App Status (runtime)
// ---------------------------------------------------------------------------

export interface AppStatus {
  name: string;
  status: 'running' | 'stopped' | 'errored';
  workers: WorkerInfo[];
  config: AppConfig;
  startedAt: number | null;
}

// ---------------------------------------------------------------------------
// Backoff State
// ---------------------------------------------------------------------------

export interface BackoffState {
  consecutiveCrashes: number;
  lastCrashAt: number;
  nextRestartAt: number;
  totalRestarts: number;
  windowStart: number;
  restartsInWindow: number;
}
