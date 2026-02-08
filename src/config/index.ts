// ---------------------------------------------------------------------------
// bunpm2 – Config Module Barrel Export
// ---------------------------------------------------------------------------

export { loadConfig, loadFromCLI } from './loader';
export type { CLIArgs } from './loader';

export { validateConfig, validateApp, resolveInstances } from './validator';

export type {
  AppConfig,
  BackoffConfig,
  Bunpm2Config,
  ClusteringConfig,
  ClusterStrategy,
  DaemonConfig,
  HealthCheckConfig,
  LogsConfig,
  MetricsConfig,
  WorkerState,
  WorkerInfo,
  WorkerMessage,
  MasterMessage,
  ControlRequest,
  ControlResponse,
  ControlStreamChunk,
  AppStatus,
  BackoffState,
  MemoryMetrics,
  CpuMetrics,
  WorkerMetricsPayload,
} from './types';
