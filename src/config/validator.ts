// ---------------------------------------------------------------------------
// bunpm2 – Config Validation & Defaults
// ---------------------------------------------------------------------------

import { APP_DEFAULTS } from '../constants';
import type { AppConfig, Bunpm2Config } from './types';
import {
  assertString,
  isRecord,
  validateBackoff,
  validateBoundedNumber,
  validateClustering,
  validateEnv,
  validateHealthCheck,
  validateInstances,
  validateLogs,
  validateMetrics,
  validatePort,
  validateShutdownSignal,
} from './validate-helpers';

// ---------------------------------------------------------------------------
// Instance resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the `instances` value.
 *
 * - A positive integer is returned as-is.
 * - `'max'` resolves to the number of logical CPUs available.
 */
export function resolveInstances(instances: number | 'max'): number {
  if (instances === 'max') {
    return navigator.hardwareConcurrency;
  }
  return instances;
}

// ---------------------------------------------------------------------------
// App-level validation
// ---------------------------------------------------------------------------

/**
 * Validate a single app configuration object and apply defaults.
 *
 * Required fields: `name`, `script`.
 */
export function validateApp(raw: unknown): AppConfig {
  if (!isRecord(raw)) {
    throw new Error('App config must be a plain object.');
  }

  const ctx = typeof raw.name === 'string' ? `app:${raw.name}` : 'app';

  // --- Required fields -------------------------------------------------------
  assertString(raw.name, 'name', ctx);
  assertString(raw.script, 'script', ctx);

  // --- Instances & port ------------------------------------------------------
  const instances = validateInstances(raw.instances, ctx);

  if (raw.port !== undefined && raw.port !== null) {
    validatePort(raw.port, 'port', ctx);
  }

  // --- Build result ----------------------------------------------------------
  const config: AppConfig = {
    name: raw.name,
    script: raw.script,
    instances,
    maxRestarts:
      validateBoundedNumber(raw.maxRestarts, 'maxRestarts', ctx, 0, 10_000) ??
      APP_DEFAULTS.maxRestarts,
    maxRestartWindow:
      validateBoundedNumber(raw.maxRestartWindow, 'maxRestartWindow', ctx, 0, 86_400_000) ??
      APP_DEFAULTS.maxRestartWindow,
    minUptime:
      validateBoundedNumber(raw.minUptime, 'minUptime', ctx, 0, 600_000) ?? APP_DEFAULTS.minUptime,
    killTimeout:
      validateBoundedNumber(raw.killTimeout, 'killTimeout', ctx, 1_000, 120_000) ??
      APP_DEFAULTS.killTimeout,
    shutdownSignal: validateShutdownSignal(raw.shutdownSignal, ctx),
    readyTimeout:
      validateBoundedNumber(raw.readyTimeout, 'readyTimeout', ctx, 1_000, 300_000) ??
      APP_DEFAULTS.readyTimeout,
    backoff: validateBackoff(raw.backoff, ctx),
  };

  // --- Optional fields -------------------------------------------------------
  if (raw.port !== undefined && raw.port !== null) {
    config.port = raw.port as number;
  }

  const env = validateEnv(raw.env, ctx);
  if (env) config.env = env;

  if (typeof raw.cwd === 'string' && raw.cwd.length > 0) {
    config.cwd = raw.cwd;
  }

  if (typeof raw.interpreter === 'string' && raw.interpreter.length > 0) {
    config.interpreter = raw.interpreter;
  }

  // --- Sub-configs -----------------------------------------------------------
  if (raw.healthCheck !== undefined) {
    config.healthCheck = validateHealthCheck(raw.healthCheck, ctx);
  }

  if (raw.logs !== undefined) {
    config.logs = validateLogs(raw.logs, ctx);
  }

  if (raw.metrics !== undefined) {
    config.metrics = validateMetrics(raw.metrics, ctx);
  }

  if (raw.clustering !== undefined) {
    config.clustering = validateClustering(raw.clustering, ctx);
  }

  return config;
}

// ---------------------------------------------------------------------------
// Top-level config validation
// ---------------------------------------------------------------------------

/**
 * Validate a full bunpm2 config (one or more apps).
 *
 * The input may be:
 *  - `{ apps: [...] }` (standard multi-app format)
 *  - A single app object (auto-wrapped into `{ apps: [app] }`)
 *
 * Returns a fully validated `Bunpm2Config` with defaults applied.
 */
export function validateConfig(raw: unknown): Bunpm2Config {
  if (!isRecord(raw)) {
    throw new Error('Config must be a plain object.');
  }

  // Allow a single-app shorthand (no `apps` array).
  let rawApps: unknown[];
  if (Array.isArray(raw.apps)) {
    rawApps = raw.apps;
  } else if (raw.script !== undefined) {
    // Treat the entire object as a single app definition.
    rawApps = [raw];
  } else {
    throw new Error('Config must contain an "apps" array or at minimum a "script" field.');
  }

  if (rawApps.length === 0) {
    throw new Error('"apps" array must contain at least one app config.');
  }

  // Validate every app and check for duplicate names and port conflicts.
  const apps: AppConfig[] = [];
  const seenNames = new Set<string>();
  const seenPorts = new Map<number, string>();

  for (let i = 0; i < rawApps.length; i++) {
    const app = validateApp(rawApps[i]);
    if (seenNames.has(app.name)) {
      throw new Error(`Duplicate app name "${app.name}".`);
    }
    seenNames.add(app.name);

    if (app.port !== undefined) {
      const existing = seenPorts.get(app.port);
      if (existing) {
        throw new Error(`Port ${app.port} is used by both "${existing}" and "${app.name}".`);
      }
      seenPorts.set(app.port, app.name);
    }

    apps.push(app);
  }

  // Daemon config (optional, pass-through).
  const config: Bunpm2Config = { apps };

  if (isRecord(raw.daemon)) {
    config.daemon = {};
    if (typeof raw.daemon.pidFile === 'string') {
      config.daemon.pidFile = raw.daemon.pidFile;
    }
    if (typeof raw.daemon.socketFile === 'string') {
      config.daemon.socketFile = raw.daemon.socketFile;
    }
    if (typeof raw.daemon.logFile === 'string') {
      config.daemon.logFile = raw.daemon.logFile;
    }
  }

  return config;
}
