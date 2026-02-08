// ---------------------------------------------------------------------------
// bunpm2 – Configuration & Domain Types
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
  timestamp: number;
}

export interface CpuMetrics {
  user: number;
  system: number;
  percentage: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface WorkerInfo {
  id: number;
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
  };
  cpu: {
    user: number;
    system: number;
  };
  eventLoopLag?: number;
  activeHandles?: number;
  activeRequests?: number;
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

export interface Bunpm2Config {
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
