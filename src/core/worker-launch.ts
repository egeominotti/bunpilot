// ---------------------------------------------------------------------------
// bunpilot – Shared Worker Spawn Wiring
// ---------------------------------------------------------------------------
//
// Both the initial spawn and the restart path need identical wiring: spawn the
// process, route IPC messages, register exit handling, start health/heartbeat
// monitors and pipe logs. Centralising it here guarantees a fix to one path
// can't silently miss the other (the root risk behind the C1 restart bug).
//
// Collaborators are passed in via a `LaunchDeps` object that the orchestrator
// rebuilds from its live fields on every call, so test stubs that replace
// those fields after construction are honoured.
// ---------------------------------------------------------------------------

import type { WorkerInfo, WorkerMessage } from '../config/types';
import { DEFAULT_LOGS, PORT_RELEASE_DELAY } from '../constants';
import { bindsWithReusePort } from '../cluster/policy';
import type { ProcessManager, SpawnedWorker } from './process-manager';
import type { HealthChecker } from '../health/checker';
import type { LogManager } from '../logs/manager';
import type { ProxyCluster } from '../cluster/proxy';
import type { WorkerHandler, ManagedApp } from './worker-handler';

export interface LaunchDeps {
  processManager: ProcessManager;
  healthChecker: HealthChecker;
  logManager: LogManager;
  workerHandler: WorkerHandler;
  getProxy: (name: string) => ProxyCluster | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawn the process for an existing worker entry and wire up monitors/logs. */
export function launchWorker(deps: LaunchDeps, managed: ManagedApp, worker: WorkerInfo): void {
  const spawned = deps.processManager.spawnWorker(
    managed.config,
    worker.id,
    (wid, msg) => handleWorkerMessage(deps, managed, wid, msg),
    (wid, code, sig) => handleWorkerExit(deps, managed, wid, code, sig),
  );

  worker.pid = spawned.pid;
  managed.spawned.set(worker.id, spawned);
  deps.workerHandler.scheduleStableCheck(managed, worker);
  startWorkerMonitors(deps, managed, worker.id);
  pipeWorkerLogs(deps, managed, worker.id, spawned);
}

/**
 * C1 fix: restarting a worker must KILL the old process and WAIT for it to
 * exit before spawning the replacement on the same port; otherwise the
 * replacement fails to bind (EADDRINUSE) and crashes in a loop.
 */
export async function restartWorker(
  deps: LaunchDeps,
  managed: ManagedApp,
  worker: WorkerInfo,
): Promise<void> {
  const oldSpawned = managed.spawned.get(worker.id);
  if (oldSpawned && deps.processManager.isRunning(oldSpawned.pid)) {
    // Force 'stopping' before the kill so the SIGTERM-induced exit is handled
    // as a graceful stop, not a crash — otherwise restarting a ported worker
    // spuriously bumps consecutiveCrashes and arms a stale backoff timer.
    worker.state = 'stopping';
    await deps.processManager.killWorker(
      oldSpawned.pid,
      managed.config.shutdownSignal,
      managed.config.killTimeout,
    );
  }

  // Let the OS release the port before the replacement binds it. Skip under
  // reusePort, where concurrent binds to the same port are legal.
  if (managed.config.port !== undefined && !bindsWithReusePort(managed.config)) {
    await sleep(PORT_RELEASE_DELAY);
  }

  // Bug 3 fix: For non-standard restart paths (online/starting -> spawning),
  // force the state to 'stopped' first so the transition to 'spawning' is valid.
  if (!deps.workerHandler.transitionWorker(worker, 'spawning')) {
    worker.state = 'stopped';
    deps.workerHandler.transitionWorker(worker, 'spawning');
  }

  worker.restartCount += 1;
  managed.spawned.delete(worker.id);

  deps.workerHandler.transitionWorker(worker, 'starting');
  worker.startedAt = Date.now();
  worker.readyAt = null;
  worker.exitCode = null;
  worker.signalCode = null;

  launchWorker(deps, managed, worker);
}

/** Schedule an async restart without unhandled rejections at sync call sites. */
export function scheduleRestart(deps: LaunchDeps, managed: ManagedApp, worker: WorkerInfo): void {
  void restartWorker(deps, managed, worker).catch((err) => {
    console.error(`[master] failed to restart worker ${worker.id}:`, err);
  });
}

function handleWorkerMessage(
  deps: LaunchDeps,
  managed: ManagedApp,
  wid: number,
  msg: WorkerMessage,
): void {
  deps.workerHandler.handleMessage(managed, wid, msg);
  if (msg.type === 'ready') {
    deps.getProxy(managed.config.name)?.addWorker(wid);
  }
  if (msg.type === 'heartbeat') {
    deps.healthChecker.onHeartbeat(wid);
  }
}

function handleWorkerExit(
  deps: LaunchDeps,
  managed: ManagedApp,
  wid: number,
  code: number | null,
  sig: string | null,
): void {
  deps.getProxy(managed.config.name)?.removeWorker(wid);
  deps.workerHandler.handleExit(managed, wid, code, sig, (m, w) => scheduleRestart(deps, m, w));
}

function startWorkerMonitors(deps: LaunchDeps, managed: ManagedApp, workerId: number): void {
  deps.healthChecker.startChecking(workerId, managed.config);
  deps.healthChecker.startHeartbeatMonitor(workerId, (wid) => {
    console.warn(`[master] worker ${wid} heartbeat stale`);
    deps.healthChecker.stopChecking(wid);
    deps.healthChecker.stopHeartbeatMonitor(wid);
    const w = deps.workerHandler.findWorker(managed, wid);
    if (w && (w.state === 'online' || w.state === 'starting')) {
      scheduleRestart(deps, managed, w);
    }
  });
}

function pipeWorkerLogs(
  deps: LaunchDeps,
  managed: ManagedApp,
  workerId: number,
  spawned: SpawnedWorker,
): void {
  const logsConfig = managed.config.logs ?? DEFAULT_LOGS;
  const isDaemon = !!process.env.BUNPILOT_DAEMON;
  deps.logManager.pipeOutput(
    managed.config.name,
    workerId,
    spawned.stdout,
    spawned.stderr,
    logsConfig,
    !isDaemon,
  );
}
