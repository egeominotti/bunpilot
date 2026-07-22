// ---------------------------------------------------------------------------
// bunpilot – Validation Helpers & Sub-Config Validators
// ---------------------------------------------------------------------------

import { isAbsolute, normalize } from 'node:path';
import {
  APP_DEFAULTS,
  DEFAULT_BACKOFF,
  DEFAULT_CLUSTERING,
  DEFAULT_HEALTH_CHECK,
  DEFAULT_LOGS,
  DEFAULT_METRICS,
} from '../constants';
import type {
  BackoffConfig,
  ClusteringConfig,
  ClusterStrategy,
  HealthCheckConfig,
  LogsConfig,
  MetricsConfig,
} from './types';

// ---------------------------------------------------------------------------
// Type Guards
// ---------------------------------------------------------------------------

export function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const prototype = Object.getPrototypeOf(v);
  return prototype === Object.prototype || prototype === null;
}

// ---------------------------------------------------------------------------
// Assertion Helpers
// ---------------------------------------------------------------------------

export function assertString(
  value: unknown,
  field: string,
  context: string,
): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`[${context}] "${field}" must be a non-empty string.`);
  }
}

/** Validate an optional boolean without silently accepting misspellings. */
function validateBoolean(value: unknown, field: string, ctx: string, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`[${ctx}] "${field}" must be a boolean.`);
  }
  return value;
}

/** Validate an optional non-empty string. */
export function validateOptionalString(
  value: unknown,
  field: string,
  ctx: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  assertString(value, field, ctx);
  if (value.includes('\0')) {
    throw new Error(`[${ctx}] "${field}" must not contain NUL characters.`);
  }
  return value;
}

export function assertNumber(
  value: unknown,
  field: string,
  context: string,
): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`[${context}] "${field}" must be a finite number.`);
  }
}

export function assertPositiveInt(
  value: unknown,
  field: string,
  context: string,
): asserts value is number {
  assertNumber(value, field, context);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`[${context}] "${field}" must be a positive integer.`);
  }
}

// ---------------------------------------------------------------------------
// Bounded Number Validator
// ---------------------------------------------------------------------------

export function validateBoundedNumber(
  value: unknown,
  field: string,
  ctx: string,
  min: number,
  max: number,
  integer?: boolean,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  assertNumber(value, field, ctx);
  if (integer && !Number.isInteger(value)) {
    throw new Error(`[${ctx}] "${field}" must be an integer. Got ${value}.`);
  }
  if (value < min || value > max) {
    throw new Error(`[${ctx}] "${field}" must be between ${min} and ${max}. Got ${value}.`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Port Validator
// ---------------------------------------------------------------------------

export function validatePort(value: unknown, field: string, ctx: string): void {
  assertNumber(value, field, ctx);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`[${ctx}] "${field}" must be an integer between 1 and 65535. Got ${value}.`);
  }
}

// ---------------------------------------------------------------------------
// Instances Validator
// ---------------------------------------------------------------------------

export function validateInstances(value: unknown, ctx: string): number | 'max' {
  if (value === 'max') return 'max';
  if (value === undefined || value === null) return 1;
  assertPositiveInt(value, 'instances', ctx);
  return value;
}

// ---------------------------------------------------------------------------
// Shutdown Signal Validator
// ---------------------------------------------------------------------------

export function validateShutdownSignal(value: unknown, ctx: string): 'SIGTERM' | 'SIGINT' {
  if (value === undefined || value === null) return APP_DEFAULTS.shutdownSignal;
  if (value !== 'SIGTERM' && value !== 'SIGINT') {
    throw new Error(
      `[${ctx}] "shutdownSignal" must be "SIGTERM" or "SIGINT". Got "${String(value)}".`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Env Validator
// ---------------------------------------------------------------------------

export function validateEnv(value: unknown, ctx: string): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error(`[${ctx}] "env" must be a plain object.`);
  }
  for (const [k, v] of Object.entries(value)) {
    if (k.length === 0 || k.includes('=') || k.includes('\0')) {
      throw new Error(`[${ctx}] environment variable name "${k}" is invalid.`);
    }
    if (typeof v !== 'string') {
      throw new Error(`[${ctx}] "env.${k}" must be a string. Got ${typeof v}.`);
    }
    if (v.includes('\0')) {
      throw new Error(`[${ctx}] "env.${k}" must not contain NUL characters.`);
    }
  }
  return { ...(value as Record<string, string>) };
}

// ---------------------------------------------------------------------------
// Sub-Config Validators
// ---------------------------------------------------------------------------

export function validateHealthCheck(raw: unknown, ctx: string): HealthCheckConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_HEALTH_CHECK };
  if (!isRecord(raw)) {
    throw new Error(`[${ctx}] "healthCheck" must be an object.`);
  }

  const config: HealthCheckConfig = {
    enabled: validateBoolean(raw.enabled, 'healthCheck.enabled', ctx, DEFAULT_HEALTH_CHECK.enabled),
    path: (() => {
      const p =
        validateOptionalString(raw.path, 'healthCheck.path', ctx) ?? DEFAULT_HEALTH_CHECK.path;
      if (!p.startsWith('/')) {
        throw new Error(`[${ctx}] "healthCheck.path" must start with "/". Got "${p}".`);
      }
      return p;
    })(),
    interval:
      validateBoundedNumber(raw.interval, 'healthCheck.interval', ctx, 1_000, 600_000, true) ??
      DEFAULT_HEALTH_CHECK.interval,
    timeout:
      validateBoundedNumber(raw.timeout, 'healthCheck.timeout', ctx, 500, 60_000, true) ??
      DEFAULT_HEALTH_CHECK.timeout,
    unhealthyThreshold:
      validateBoundedNumber(
        raw.unhealthyThreshold,
        'healthCheck.unhealthyThreshold',
        ctx,
        1,
        100,
        true,
      ) ?? DEFAULT_HEALTH_CHECK.unhealthyThreshold,
  };

  if (config.timeout >= config.interval) {
    throw new Error(
      `[${ctx}] "healthCheck.timeout" (${config.timeout}) must be less than "healthCheck.interval" (${config.interval}).`,
    );
  }

  return config;
}

export function validateBackoff(raw: unknown, ctx: string): BackoffConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_BACKOFF };
  if (!isRecord(raw)) {
    throw new Error(`[${ctx}] "backoff" must be an object.`);
  }

  const config: BackoffConfig = {
    initial:
      validateBoundedNumber(raw.initial, 'backoff.initial', ctx, 100, 300_000) ??
      DEFAULT_BACKOFF.initial,
    multiplier:
      validateBoundedNumber(raw.multiplier, 'backoff.multiplier', ctx, 1, 10) ??
      DEFAULT_BACKOFF.multiplier,
    max: validateBoundedNumber(raw.max, 'backoff.max', ctx, 1_000, 600_000) ?? DEFAULT_BACKOFF.max,
  };

  if (config.initial > config.max) {
    throw new Error(
      `[${ctx}] "backoff.initial" (${config.initial}) must not exceed "backoff.max" (${config.max}).`,
    );
  }

  return config;
}

export function validateLogs(raw: unknown, ctx: string): LogsConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_LOGS };
  if (!isRecord(raw)) {
    throw new Error(`[${ctx}] "logs" must be an object.`);
  }

  const result: LogsConfig = {
    maxSize:
      validateBoundedNumber(raw.maxSize, 'logs.maxSize', ctx, 1024, 1_073_741_824, true) ??
      DEFAULT_LOGS.maxSize,
    maxFiles:
      validateBoundedNumber(raw.maxFiles, 'logs.maxFiles', ctx, 1, 100, true) ??
      DEFAULT_LOGS.maxFiles,
  };

  const outFile = validateOptionalString(raw.outFile, 'logs.outFile', ctx);
  const errFile = validateOptionalString(raw.errFile, 'logs.errFile', ctx);
  for (const [field, filename] of [
    ['logs.outFile', outFile],
    ['logs.errFile', errFile],
  ] as const) {
    if (filename && (isAbsolute(filename) || normalize(filename).split(/[\\/]/).includes('..'))) {
      throw new Error(`[${ctx}] "${field}" must stay inside the app log directory.`);
    }
  }
  if (outFile) result.outFile = outFile;
  if (errFile) result.errFile = errFile;

  return result;
}

export function validateMetrics(raw: unknown, ctx: string): MetricsConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_METRICS };
  if (!isRecord(raw)) {
    throw new Error(`[${ctx}] "metrics" must be an object.`);
  }

  const result: MetricsConfig = {
    enabled: validateBoolean(raw.enabled, 'metrics.enabled', ctx, DEFAULT_METRICS.enabled),
    prometheus: validateBoolean(
      raw.prometheus,
      'metrics.prometheus',
      ctx,
      DEFAULT_METRICS.prometheus,
    ),
    collectInterval:
      validateBoundedNumber(raw.collectInterval, 'metrics.collectInterval', ctx, 1_000, 300_000) ??
      DEFAULT_METRICS.collectInterval,
  };

  if (raw.httpPort !== undefined) {
    validatePort(raw.httpPort, 'metrics.httpPort', ctx);
    result.httpPort = raw.httpPort as number;
  } else {
    result.httpPort = DEFAULT_METRICS.httpPort;
  }

  return result;
}

export function validateClustering(raw: unknown, ctx: string): ClusteringConfig {
  if (raw === undefined || raw === null) {
    return { ...DEFAULT_CLUSTERING, rollingRestart: { ...DEFAULT_CLUSTERING.rollingRestart } };
  }
  if (!isRecord(raw)) {
    throw new Error(`[${ctx}] "clustering" must be an object.`);
  }

  const validStrategies: ClusterStrategy[] = ['reusePort', 'proxy', 'auto'];

  if (raw.strategy !== undefined && raw.strategy !== null) {
    if (
      typeof raw.strategy !== 'string' ||
      !validStrategies.includes(raw.strategy as ClusterStrategy)
    ) {
      throw new Error(
        `[${ctx}] "clustering.strategy" must be one of "reusePort", "proxy", "auto". Got "${String(raw.strategy)}".`,
      );
    }
  }

  const strategy =
    typeof raw.strategy === 'string' && validStrategies.includes(raw.strategy as ClusterStrategy)
      ? (raw.strategy as ClusterStrategy)
      : DEFAULT_CLUSTERING.strategy;

  let rollingRestart = { ...DEFAULT_CLUSTERING.rollingRestart };
  if (
    raw.rollingRestart !== undefined &&
    raw.rollingRestart !== null &&
    !isRecord(raw.rollingRestart)
  ) {
    throw new Error(`[${ctx}] "clustering.rollingRestart" must be an object.`);
  }
  if (isRecord(raw.rollingRestart)) {
    rollingRestart = {
      batchSize:
        validateBoundedNumber(
          raw.rollingRestart.batchSize,
          'clustering.rollingRestart.batchSize',
          ctx,
          1,
          100,
          true,
        ) ?? DEFAULT_CLUSTERING.rollingRestart.batchSize,
      batchDelay:
        validateBoundedNumber(
          raw.rollingRestart.batchDelay,
          'clustering.rollingRestart.batchDelay',
          ctx,
          0,
          300_000,
          true,
        ) ?? DEFAULT_CLUSTERING.rollingRestart.batchDelay,
    };
  }

  return {
    enabled: validateBoolean(raw.enabled, 'clustering.enabled', ctx, DEFAULT_CLUSTERING.enabled),
    strategy,
    rollingRestart,
  };
}
