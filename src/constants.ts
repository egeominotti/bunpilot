// ---------------------------------------------------------------------------
// bunpm – Global Constants & Defaults
// ---------------------------------------------------------------------------

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type {
  AppConfig,
  BackoffConfig,
  HealthCheckConfig,
  LogsConfig,
  MetricsConfig,
  ClusteringConfig,
} from './config/types';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const BUNPM_HOME = process.env.BUNPM_HOME ?? join(homedir(), '.bunpm');
export const SOCKET_PATH = process.env.BUNPM_SOCKET ?? join(BUNPM_HOME, 'bunpm.sock');
export const PID_FILE = join(BUNPM_HOME, 'bunpm.pid');
export const DB_PATH = join(BUNPM_HOME, 'bunpm.db');
export const LOGS_DIR = join(BUNPM_HOME, 'logs');
export const DAEMON_LOG = join(BUNPM_HOME, 'bunpm-daemon.log');

// ---------------------------------------------------------------------------
// Config File Names (lookup order)
// ---------------------------------------------------------------------------

export const CONFIG_FILES = ['bunpm.config.ts', 'bunpm.config.js', 'bunpm.json'] as const;

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

export const INTERNAL_PORT_BASE = 40_001;

/** Env keys the master uses internally – never leaked to workers */
export const INTERNAL_ENV_KEYS = new Set([
  'BUNPM_DAEMON',
  'BUNPM_CONTROL_SOCKET',
  'BUNPM_INTERNAL_PORT_BASE',
]);

// ---------------------------------------------------------------------------
// Default Configs
// ---------------------------------------------------------------------------

export const DEFAULT_HEALTH_CHECK: HealthCheckConfig = {
  enabled: true,
  path: '/health',
  interval: 30_000,
  timeout: 5_000,
  unhealthyThreshold: 3,
};

export const DEFAULT_BACKOFF: BackoffConfig = {
  initial: 1_000,
  multiplier: 2,
  max: 30_000,
};

export const DEFAULT_LOGS: LogsConfig = {
  maxSize: 10 * 1024 * 1024,
  maxFiles: 5,
};

export const DEFAULT_METRICS: MetricsConfig = {
  enabled: true,
  httpPort: 9_615,
  prometheus: false,
  collectInterval: 5_000,
};

export const DEFAULT_CLUSTERING: ClusteringConfig = {
  enabled: true,
  strategy: 'auto',
  rollingRestart: {
    batchSize: 1,
    batchDelay: 1_000,
  },
};

export const APP_DEFAULTS: Pick<
  AppConfig,
  | 'maxRestarts'
  | 'maxRestartWindow'
  | 'minUptime'
  | 'killTimeout'
  | 'shutdownSignal'
  | 'readyTimeout'
> = {
  maxRestarts: 15,
  maxRestartWindow: 900_000,
  minUptime: 30_000,
  killTimeout: 5_000,
  shutdownSignal: 'SIGTERM',
  readyTimeout: 30_000,
};

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export const HEARTBEAT_INTERVAL = 10_000;
export const HEARTBEAT_MISS_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// Home Directory Bootstrap
// ---------------------------------------------------------------------------

/** Ensure the BUNPM_HOME directory tree exists. */
export function ensureBunpmHome(): void {
  mkdirSync(BUNPM_HOME, { recursive: true });
}
