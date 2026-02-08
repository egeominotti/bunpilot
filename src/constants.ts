// ---------------------------------------------------------------------------
// bunpm2 – Global Constants & Defaults
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

export const BUNPM2_HOME = process.env.BUNPM2_HOME ?? join(homedir(), '.bunpm2');
export const SOCKET_PATH = process.env.BUNPM2_SOCKET ?? join(BUNPM2_HOME, 'bunpm2.sock');
export const PID_FILE = join(BUNPM2_HOME, 'bunpm2.pid');
export const DB_PATH = join(BUNPM2_HOME, 'bunpm2.db');
export const LOGS_DIR = join(BUNPM2_HOME, 'logs');
export const DAEMON_LOG = join(BUNPM2_HOME, 'bunpm2-daemon.log');

// ---------------------------------------------------------------------------
// Config File Names (lookup order)
// ---------------------------------------------------------------------------

export const CONFIG_FILES = ['bunpm2.config.ts', 'bunpm2.config.js', 'bunpm2.json'] as const;

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

export const INTERNAL_PORT_BASE = 40_001;

/** Env keys the master uses internally – never leaked to workers */
export const INTERNAL_ENV_KEYS = new Set([
  'BUNPM2_DAEMON',
  'BUNPM2_CONTROL_SOCKET',
  'BUNPM2_INTERNAL_PORT_BASE',
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

/** Ensure the BUNPM2_HOME directory tree exists. */
export function ensureBunpm2Home(): void {
  mkdirSync(BUNPM2_HOME, { recursive: true });
}
