// ---------------------------------------------------------------------------
// bunpilot – Config Module Barrel Export
// ---------------------------------------------------------------------------

export type { CLIArgs } from './loader';
export { loadConfig, loadFromCLI } from './loader';
export type {
  AppConfig,
  AppStatus,
  BackoffConfig,
  BackoffState,
  BunpilotConfig,
  ClusteringConfig,
  ClusterStrategy,
  ControlRequest,
  ControlResponse,
  ControlStreamChunk,
  CpuMetrics,
  DaemonConfig,
  HealthCheckConfig,
  LogsConfig,
  MasterMessage,
  MemoryMetrics,
  MetricsConfig,
  WorkerInfo,
  WorkerMessage,
  WorkerMetricsPayload,
  WorkerState,
} from './types';
export { resolveInstances, validateApp, validateConfig } from './validator';
