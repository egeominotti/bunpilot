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
  };
}

/** Derive the public AppStatus from a managed app's worker states. */
export function toAppStatus(managed: ManagedApp): AppStatus {
  const allStopped = managed.workers.every((w) => w.state === 'stopped' || w.state === 'errored');
  const hasErrored = managed.workers.some((w) => w.state === 'errored');

  let status: AppStatus['status'];
  if (managed.workers.length === 0) {
    status = managed.startedAt !== null ? 'running' : 'stopped';
  } else if (allStopped) {
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
    })),
    config: structuredClone(managed.config),
    startedAt: managed.startedAt,
  };
}
