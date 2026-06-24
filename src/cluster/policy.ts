// ---------------------------------------------------------------------------
// bunpilot – Cluster Policy (pure decisions)
// ---------------------------------------------------------------------------
//
// Pure helpers that decide how an app's instances/ports behave. Kept separate
// from the orchestrator so they can be reasoned about and unit-tested without
// any process or socket state.
// ---------------------------------------------------------------------------

import { cpus } from 'node:os';
import type { AppConfig } from '../config/types';
import { INTERNAL_PORT_BASE } from '../constants';
import { detectStrategy } from './platform';

/** Resolve `'max'` to the CPU count; pass numbers through unchanged. */
export function resolveInstances(value: number | 'max'): number {
  return value === 'max' ? cpus().length : value;
}

/** Whether an app should run behind the userland TCP proxy cluster. */
export function shouldUseProxy(config: AppConfig, instances: number): boolean {
  if (!config.clustering?.enabled) return false;
  if (instances <= 1) return false;
  if (config.port === undefined) return false;
  return detectStrategy(config.clustering.strategy ?? 'auto') === 'proxy';
}

/**
 * Whether this app's workers bind their port with SO_REUSEPORT. When true,
 * concurrent binds to the same port are legal, so a restart needs no
 * port-release delay.
 */
export function bindsWithReusePort(config: AppConfig): boolean {
  const clustered = config.clustering?.enabled === true && resolveInstances(config.instances) !== 1;
  if (!clustered) return false;
  return detectStrategy(config.clustering?.strategy ?? 'auto') === 'reusePort';
}

/**
 * The port a worker actually binds, or `undefined` when none is configured.
 *
 * This is the single source of truth shared by `ProcessManager.buildEnv` (which
 * injects `BUNPILOT_PORT`) and `HealthChecker.getWorkerPort` (which probes it),
 * so the two can never drift:
 *
 * - clustered + reusePort -> the public `config.port` (shared via SO_REUSEPORT)
 * - clustered + proxy     -> the per-worker internal port
 * - otherwise             -> `config.port` (may be undefined)
 */
export function resolveWorkerPort(config: AppConfig, workerId: number): number | undefined {
  const isClustered = config.clustering?.enabled === true && config.instances !== 1;
  if (isClustered && config.port !== undefined) {
    const strategy = detectStrategy(config.clustering?.strategy ?? 'auto');
    return strategy === 'reusePort' ? config.port : INTERNAL_PORT_BASE + workerId;
  }
  return config.port;
}
