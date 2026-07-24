// ---------------------------------------------------------------------------
// bunpilot – Pure helpers for worker/app status
// ---------------------------------------------------------------------------
//
// Extracted from MasterOrchestrator so the orchestrator stays focused on
// lifecycle wiring. These are pure functions (no I/O, no orchestrator state)
// and are unit-testable in isolation.
// ---------------------------------------------------------------------------

import type { AppStatus, WorkerInfo } from '../config/types';
import type { ManagedApp } from './worker-handler';

/** Build a fresh WorkerInfo for a newly created worker slot. */
export function createWorkerInfo(workerId: number): WorkerInfo {
  return {
    id: workerId,
    slot: workerId,
    pid: 0,
    state: 'spawning',
    startedAt: Date.now(),
    readyAt: null,
    restartCount: 0,
    consecutiveCrashes: 0,
    lastCrashAt: null,
    exitCode: null,
    signalCode: null,
    memory: null,
    cpu: null,
    telemetry: null,
  };
}

/** Derive the public AppStatus from a managed app's worker states. */
export function toAppStatus(managed: ManagedApp): AppStatus {
  const hasErrored = managed.workers.some((w) => w.state === 'errored');

  let status: AppStatus['status'];
  if (managed.startedAt === null) {
    // The app has been stopped/deleted: no restart is coming, so even a worker
    // still tagged 'crashed' (mid-backoff at stop time) is terminal — the app
    // must never report 'running' (h36). 'errored' (gave up) surfaces as errored.
    status = hasErrored ? 'errored' : 'stopped';
  } else if (managed.workers.length === 0) {
    status = 'running';
  } else if (managed.workers.every((w) => w.state === 'stopped' || w.state === 'errored')) {
    status = hasErrored ? 'errored' : 'stopped';
  } else {
    // At least one worker is still alive (online or transitioning) -> running.
    status = 'running';
  }

  return {
    name: managed.config.name,
    status,
    workers: managed.workers.map((worker) => ({
      ...worker,
      memory: worker.memory ? { ...worker.memory } : null,
      cpu: worker.cpu ? { ...worker.cpu } : null,
      telemetry: worker.telemetry ? structuredClone(worker.telemetry) : null,
    })),
    config: redactConfig(managed.config),
    startedAt: managed.startedAt,
  };
}

/**
 * Project the config for a status snapshot with secrets removed. `toAppStatus`
 * feeds the UNAUTHENTICATED loopback metrics HTTP server (getJsonMetrics /
 * getStatus), so `env` values (DATABASE_URL, STRIPE_KEY, ...) must never be
 * echoed back — only the owner-only control socket is a trust boundary
 * (h24/h58). The env keys are still exposed so operators can see which vars are
 * configured; only their values are withheld.
 */
function redactConfig(config: ManagedApp['config']): AppStatus['config'] {
  const clone = structuredClone(config);
  if (clone.env) {
    const redacted: Record<string, string> = {};
    for (const key of Object.keys(clone.env)) {
      redacted[key] = '[redacted]';
    }
    clone.env = redacted;
  }
  return clone;
}
