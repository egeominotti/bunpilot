// ---------------------------------------------------------------------------
// bunpilot – Config Validation & Defaults
// ---------------------------------------------------------------------------

import { basename, dirname, extname, join, normalize } from 'node:path';
import { resolveInstances } from '../cluster/policy';
import { APP_DEFAULTS, DEFAULT_METRICS } from '../constants';

export { resolveInstances } from '../cluster/policy';

import type { AppConfig, BunpilotConfig } from './types';
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
  validateOptionalString,
  validatePort,
  validateShutdownSignal,
} from './validate-helpers';

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
  if (raw.name === '.' || raw.name === '..') {
    throw new Error(`[${ctx}] "name" must not be "." or "..".`);
  }
  if (/[\\/]/.test(raw.name)) {
    throw new Error(`[${ctx}] "name" must not contain path separators.`);
  }
  if (raw.name.length > 128) {
    throw new Error(`[${ctx}] "name" must be at most 128 characters.`);
  }
  if (/\p{Cc}/u.test(raw.name)) {
    throw new Error(`[${ctx}] "name" must not contain control characters.`);
  }
  if (raw.name.includes('\0') || raw.script.includes('\0')) {
    throw new Error(`[${ctx}] "name" and "script" must not contain NUL characters.`);
  }

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
      validateBoundedNumber(raw.maxRestarts, 'maxRestarts', ctx, 0, 10_000, true) ??
      APP_DEFAULTS.maxRestarts,
    maxRestartWindow:
      validateBoundedNumber(
        raw.maxRestartWindow,
        'maxRestartWindow',
        ctx,
        1_000,
        86_400_000,
        true,
      ) ?? APP_DEFAULTS.maxRestartWindow,
    minUptime:
      validateBoundedNumber(raw.minUptime, 'minUptime', ctx, 0, 600_000, true) ??
      APP_DEFAULTS.minUptime,
    killTimeout:
      validateBoundedNumber(raw.killTimeout, 'killTimeout', ctx, 1_000, 120_000, true) ??
      APP_DEFAULTS.killTimeout,
    shutdownSignal: validateShutdownSignal(raw.shutdownSignal, ctx),
    readyTimeout:
      validateBoundedNumber(raw.readyTimeout, 'readyTimeout', ctx, 1_000, 300_000, true) ??
      APP_DEFAULTS.readyTimeout,
    backoff: validateBackoff(raw.backoff, ctx),
    healthCheck: validateHealthCheck(raw.healthCheck, ctx),
    logs: validateLogs(raw.logs, ctx),
    metrics: validateMetrics(raw.metrics, ctx),
    clustering: validateClustering(raw.clustering, ctx),
  };

  // --- Optional fields -------------------------------------------------------
  if (raw.port !== undefined && raw.port !== null) {
    config.port = raw.port as number;
  }

  const env = validateEnv(raw.env, ctx);
  if (env) config.env = env;

  const cwd = validateOptionalString(raw.cwd, 'cwd', ctx);
  if (cwd) config.cwd = cwd;

  const interpreter = validateOptionalString(raw.interpreter, 'interpreter', ctx);
  if (interpreter) config.interpreter = interpreter;

  validateLogPathCollisions(config, ctx);

  return config;
}

/** Ensure worker suffixing cannot make stdout and stderr share another worker's file. */
function validateLogPathCollisions(config: AppConfig, ctx: string): void {
  const outFile = config.logs?.outFile;
  const errFile = config.logs?.errFile;
  if (!outFile || !errFile) return;

  const paths = new Map<string, { workerId: number; stream: string }>();
  const instances = resolveInstances(config.instances);
  for (let workerId = 0; workerId < instances; workerId++) {
    for (const [stream, filename] of [
      ['stdout', outFile],
      ['stderr', errFile],
    ] as const) {
      const path = normalize(addWorkerSuffix(filename, workerId));
      const previous = paths.get(path);
      if (previous && previous.workerId !== workerId) {
        throw new Error(
          `[${ctx}] log files for worker ${workerId} ${stream} and worker ${previous.workerId} ${previous.stream} collide at "${path}".`,
        );
      }
      paths.set(path, { workerId, stream });
    }
  }
}

function addWorkerSuffix(filename: string, workerId: number): string {
  if (workerId === 0) return filename;
  const ext = extname(filename);
  const base = basename(filename, ext);
  return join(dirname(filename), `${base}-${workerId}${ext}`);
}

// ---------------------------------------------------------------------------
// Top-level config validation
// ---------------------------------------------------------------------------

/**
 * Validate a full bunpilot config (one or more apps).
 *
 * The input may be:
 *  - `{ apps: [...] }` (standard multi-app format)
 *  - A single app object (auto-wrapped into `{ apps: [app] }`)
 *
 * Returns a fully validated `BunpilotConfig` with defaults applied.
 */
export function validateConfig(raw: unknown): BunpilotConfig {
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
  let metricsPort: { port: number; appName: string } | null = null;

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

    if (app.metrics?.enabled && app.metrics.httpPort !== undefined) {
      if (metricsPort && metricsPort.port !== app.metrics.httpPort) {
        throw new Error(
          `Enabled apps "${metricsPort.appName}" and "${app.name}" configure different metrics ports (${metricsPort.port} and ${app.metrics.httpPort}).`,
        );
      }
      metricsPort ??= { port: app.metrics.httpPort, appName: app.name };
    }

    apps.push(app);
  }

  const daemonMetricsPort = metricsPort?.port ?? DEFAULT_METRICS.httpPort;
  if (daemonMetricsPort !== undefined) {
    const conflictingApp = seenPorts.get(daemonMetricsPort);
    if (conflictingApp) {
      throw new Error(
        `Port ${daemonMetricsPort} is used by app "${conflictingApp}" and the daemon metrics listener.`,
      );
    }
  }

  // Daemon config (optional, pass-through).
  const config: BunpilotConfig = { apps };

  if (raw.daemon !== undefined && raw.daemon !== null && !isRecord(raw.daemon)) {
    throw new Error('"daemon" must be an object.');
  }

  if (isRecord(raw.daemon)) {
    config.daemon = {};
    const pidFile = validateOptionalString(raw.daemon.pidFile, 'daemon.pidFile', 'config');
    const socketFile = validateOptionalString(raw.daemon.socketFile, 'daemon.socketFile', 'config');
    const logFile = validateOptionalString(raw.daemon.logFile, 'daemon.logFile', 'config');
    if (pidFile) config.daemon.pidFile = pidFile;
    if (socketFile) config.daemon.socketFile = socketFile;
    if (logFile) config.daemon.logFile = logFile;
  }

  return config;
}
