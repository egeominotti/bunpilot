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

import { bindsWithReusePort } from '../cluster/policy';
import type { ProxyCluster } from '../cluster/proxy';
import type { WorkerInfo, WorkerMessage } from '../config/types';
import {
  DEFAULT_LOGS,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_MISS_THRESHOLD,
  PORT_RELEASE_DELAY,
} from '../constants';
import type { HealthChecker } from '../health/checker';
import type { LogManager } from '../logs/manager';
import type { ProcessManager, SpawnedWorker } from './process-manager';
import type { ManagedApp, WorkerHandler } from './worker-handler';

export interface LaunchDeps {
  processManager: ProcessManager;
  healthChecker: HealthChecker;
  logManager: LogManager;
  workerHandler: WorkerHandler;
  getProxy: (name: string) => ProxyCluster | undefined;
  /**
   * Run `fn` under the orchestrator's per-app lock. `restartWorker` uses this to
   * serialize its final check-and-launch with reload/stop/delete so a retire
   * that lands during the restart's awaits can't be raced (h16/h17). Optional so
   * hand-built LaunchDeps in tests still work (runs `fn` directly).
   */
  runExclusive?: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawn the process for an existing worker entry and wire up monitors/logs. */
export function launchWorker(deps: LaunchDeps, managed: ManagedApp, worker: WorkerInfo): void {
  const launchToken = Symbol(`${managed.config.name}:${worker.id}`);
  managed.launchTokens.set(worker.id, launchToken);
  const spawned = deps.processManager.spawnWorker(
    managed.config,
    worker.id,
    (wid, msg) => {
      if (managed.launchTokens.get(wid) === launchToken) {
        handleWorkerMessage(deps, managed, wid, msg);
      }
    },
    (wid, code, sig) => {
      if (managed.launchTokens.get(wid) === launchToken) {
        handleWorkerExit(deps, managed, wid, code, sig);
      }
    },
    managed.workerPorts.get(worker.id),
  );

  worker.pid = spawned.pid;
  managed.spawned.set(worker.id, spawned);
  deps.workerHandler.scheduleReadyTimeout(managed, worker, (timedOutWorker) => {
    console.warn(
      `[master] worker ${timedOutWorker.id} did not become ready within ${managed.config.readyTimeout}ms`,
    );
    scheduleRestart(deps, managed, timedOutWorker);
  });
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
  deps.workerHandler.clearReadyTimer(managed, worker.id);
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

  // Run the final check-and-launch under the per-app lock so it is atomic with
  // reload/stop/delete: a reload holds the lock for its whole rolling restart,
  // so either it retired this worker before we acquire the lock (the guard below
  // aborts) or we launch first and its later retire kills the fresh pid — never
  // an orphan (h16/h17/h57/h59).
  const runExclusive = deps.runExclusive ?? ((_name, fn) => fn());
  await runExclusive(managed.config.name, async () => {
    // Resurrection guard: a stop / delete / restart / reload (or global
    // shutdown, which stops every app) may have completed across the awaits
    // above. `stopping` alone is unreliable — stopApp resets it in its `finally`
    // (h5/h15/h61) — so also require the app to still be started AND this worker
    // to still be a tracked member (retire splices it out, restart replaces the
    // array: h16/h17/h23/h57/h59).
    if (managed.stopping || managed.startedAt === null || !managed.workers.includes(worker)) {
      // restartApp reuses worker ids (it clears `workers`/`spawned` and respawns
      // 0..n-1 on the same ManagedApp), so by now a NEWER generation may own this
      // id. Dropping it blindly would orphan a live process: `stopAllWorkers`
      // only kills what is in `spawned`, so the replacement would survive every
      // stop/delete/shutdown and wedge its port. Only drop the handle we own.
      if (oldSpawned !== undefined && managed.spawned.get(worker.id) === oldSpawned) {
        managed.spawned.delete(worker.id);
      }
      return;
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

    // `launchWorker` can throw at two very different points, and the difference
    // matters. `spawnWorker` is a bare `Bun.spawn` that throws synchronously on
    // ENOENT (missing script/interpreter/cwd) and on EAGAIN/EMFILE — nothing is
    // live. But the wiring AFTER the spawn (log writers -> mkdirSync/open) can
    // also throw with the child already running, and dropping its handle there
    // would orphan a live process that no stop/delete/shutdown can reach.
    // Either way the worker must not be left stranded in 'starting' with no
    // process, no timers and no retry path while the app reports 'running'.
    try {
      launchWorker(deps, managed, worker);
    } catch (error) {
      // Drop the token FIRST. The partial launch may already have queued a
      // `ready` message, and with a live token that message would promote a
      // child we are about to SIGKILL to 'online' — adding its doomed pid to
      // the proxy pool and arming health checks on it. It also keeps the kill
      // below from re-entering handleExit via the spawn's own exit callback.
      managed.launchTokens.delete(worker.id);
      // Monitors are armed just before the log wiring, so a wiring failure
      // leaves a live heartbeat interval behind. Nothing else stops it if
      // crashRecovery gives up.
      deps.healthChecker.stopChecking(worker.id, managed.config.name);
      deps.healthChecker.stopHeartbeatMonitor(worker.id, managed.config.name);
      const partial = managed.spawned.get(worker.id);
      if (partial) {
        try {
          await deps.processManager.killWorker(
            partial.pid,
            managed.config.shutdownSignal,
            managed.config.killTimeout,
          );
          managed.spawned.delete(worker.id);
        } catch (killError) {
          // Unkillable child: keep the handle registered so stopAllWorkers can
          // try again rather than losing the pid entirely.
          console.error(
            `[master] failed to kill partially-launched worker ${worker.id}:`,
            killError,
          );
        }
      } else {
        managed.spawned.delete(worker.id);
      }
      // Hand the worker to the crash machinery so backoff / maxRestarts owns
      // the retry.
      deps.workerHandler.handleExit(managed, worker.id, null, null, (m, w) =>
        scheduleRestart(deps, m, w),
      );
      throw error;
    }
  });
}

/** Schedule an async restart without unhandled rejections at sync call sites. */
export function scheduleRestart(deps: LaunchDeps, managed: ManagedApp, worker: WorkerInfo): void {
  if (managed.stopping || managed.restartingWorkers.has(worker.id)) return;
  managed.restartingWorkers.add(worker.id);
  void restartWorker(deps, managed, worker)
    .catch((err) => {
      console.error(`[master] failed to restart worker ${worker.id}:`, err);
    })
    .finally(() => {
      managed.restartingWorkers.delete(worker.id);
    });
}

function handleWorkerMessage(
  deps: LaunchDeps,
  managed: ManagedApp,
  wid: number,
  msg: WorkerMessage,
): void {
  const worker = deps.workerHandler.findWorker(managed, wid);
  const previousState = worker?.state;
  deps.workerHandler.handleMessage(managed, wid, msg);
  if (msg.type === 'ready' && worker?.state === 'online' && previousState !== 'online') {
    deps.workerHandler.clearReadyTimer(managed, wid);
    if (
      managed.config.healthCheck?.enabled &&
      (managed.config.port !== undefined || managed.workerPorts.has(wid))
    ) {
      deps.healthChecker.startChecking(
        wid,
        managed.config,
        managed.config.name,
        managed.workerPorts.get(wid),
      );
    }
    deps.workerHandler.scheduleStableCheck(managed, worker);
    deps.getProxy(managed.config.name)?.addWorker(wid, managed.workerPorts.get(wid));
  }
  if (msg.type === 'heartbeat') {
    deps.healthChecker.onHeartbeat(wid, managed.config.name);
  }
}

function handleWorkerExit(
  deps: LaunchDeps,
  managed: ManagedApp,
  wid: number,
  code: number | null,
  sig: string | null,
): void {
  deps.workerHandler.clearReadyTimer(managed, wid);
  deps.getProxy(managed.config.name)?.removeWorker(wid);
  // A dead process generation must stop being probed immediately: otherwise its
  // HTTP monitor keeps hitting the now-dead port, accumulates failures, and can
  // declare the *replacement* unhealthy and restart it (h49). A crash-restart
  // re-arms both monitors when the fresh generation launches.
  deps.healthChecker.stopChecking(wid, managed.config.name);
  deps.healthChecker.stopHeartbeatMonitor(wid, managed.config.name);
  deps.workerHandler.handleExit(managed, wid, code, sig, (m, w) => scheduleRestart(deps, m, w));
}

function startWorkerMonitors(deps: LaunchDeps, managed: ManagedApp, workerId: number): void {
  // A worker only starts emitting heartbeats from inside bunpilotReady(), so a
  // legitimately slow boot (migrations, cache warm-up) that legally consumes up
  // to `readyTimeout` (validator allows up to 300s) has emitted nothing yet. The
  // readyTimeout timer owns the boot window; give the heartbeat monitor a boot
  // grace strictly larger than readyTimeout so it can never preempt it and kill
  // a still-starting worker (h25/h28/h38).
  const bootGrace = managed.config.readyTimeout + HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD;
  deps.healthChecker.startHeartbeatMonitor(
    workerId,
    (wid) => {
      const w = deps.workerHandler.findWorker(managed, wid);
      // Only act on a worker that actually came online and then went silent.
      // A 'starting' worker is the readyTimeout timer's responsibility.
      if (w && w.state === 'online') {
        console.warn(`[master] worker ${wid} heartbeat stale`);
        deps.healthChecker.stopChecking(wid, managed.config.name);
        deps.healthChecker.stopHeartbeatMonitor(wid, managed.config.name);
        scheduleRestart(deps, managed, w);
      }
    },
    managed.config.name,
    bootGrace,
  );
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
