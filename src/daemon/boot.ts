#!/usr/bin/env bun

// ---------------------------------------------------------------------------
// bunpilot – Daemon Boot: entry point spawned by daemonize()
// ---------------------------------------------------------------------------
//
// This script is the actual process that runs in the background.
// It wires up: MasterOrchestrator + ControlServer + SignalHandlers.
// ---------------------------------------------------------------------------

import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../config/loader';
import type { AppConfig, AppStatus, BunpilotConfig } from '../config/types';
import { validateApp } from '../config/validator';
import { DEFAULT_METRICS, ensureBunpilotHome, LOGS_DIR, PID_FILE, SOCKET_PATH } from '../constants';
import { type CommandContext, createCommandHandlers } from '../control/handlers';
import { createErrorResponse } from '../control/protocol';
import { ControlServer } from '../control/server';
import { MasterOrchestrator } from '../core/master';
import { setupSignalHandlers } from '../core/signals';
import { readLogLines } from '../logs/reader';
import { type MetricsDataProvider, MetricsHttpServer } from '../metrics/http-server';
import {
  type AppMetricsInput,
  type AppWorkerMetrics,
  formatPrometheus,
} from '../metrics/prometheus';
import { SqliteStore } from '../store/sqlite';
import { resolveStorePath } from './paths';
import { isBunpilotWorkerProcess, removePidFile, writePidFile } from './pid';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** How often the persisted worker-pid set is refreshed from live state. */
const WORKER_SYNC_INTERVAL = 10_000;
/** Minimum gap between worker-sync failure log lines. */
const SYNC_ERROR_LOG_INTERVAL = 60_000;

/**
 * Reject listener collisions for apps submitted after the daemon has started.
 * The public-port conflict only applies when the daemon actually bound the
 * metrics port: with metrics disabled that port is free for user apps, so
 * `metricsEnabled` gates the check (defaults true — the conservative
 * "port is bound" assumption — for callers that don't know).
 */
export function assertAppCompatibleWithDaemon(
  config: AppConfig,
  metricsPort: number,
  metricsEnabled = true,
): void {
  if (metricsEnabled && config.port === metricsPort) {
    throw new Error(
      `App public port ${config.port} conflicts with daemon metrics port ${metricsPort}`,
    );
  }
  if (config.metrics?.enabled && config.metrics.httpPort !== metricsPort) {
    throw new Error(
      `App metrics port ${config.metrics.httpPort} does not match daemon port ${metricsPort}; restart the daemon with this config`,
    );
  }
}

export async function bootDaemon(configPath?: string): Promise<void> {
  ensureBunpilotHome();
  mkdirSync(LOGS_DIR, { recursive: true });

  let loadedConfig: BunpilotConfig | null = null;
  if (configPath) {
    loadedConfig = await loadConfig(configPath);
  }

  const socketPath = resolve(loadedConfig?.daemon?.socketFile ?? SOCKET_PATH);
  const pidFile = resolve(loadedConfig?.daemon?.pidFile ?? PID_FILE);

  // Derive the store path from this daemon's resolved paths — never the global
  // default — so two daemons booted from different configs own distinct
  // desired state instead of the second adopting the first's apps
  // (h40 / BUG CLASS E).
  const store = new SqliteStore(resolveStorePath(pidFile));

  // Everything acquired below (control socket, metrics listener, store, PID
  // file) is released by cleanup() on EVERY exit path — including a failed boot
  // step such as the metrics listener being unable to bind its port. Without a
  // spanning try/finally a partial boot leaks the already-bound control socket
  // and the open store (h52 / BUG CLASS F).
  let controlServer: ControlServer | null = null;
  let metricsServer: MetricsHttpServer | null = null;
  let workerSyncTimer: ReturnType<typeof setInterval> | null = null;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const [label, action] of [
      ['worker sync timer', () => workerSyncTimer && clearInterval(workerSyncTimer)],
      ['metrics server', () => metricsServer?.stop()],
      ['control server', () => controlServer?.stop()],
      ['store', () => store.close()],
      ['PID file', () => removePidFile(pidFile, process.pid)],
    ] as const) {
      try {
        action();
      } catch (error) {
        console.error(`[daemon] ${label} cleanup failed:`, error);
      }
    }
  };

  try {
    // -- Determine the desired app set (store restore + explicit config) -----
    // Rows persisted as 'running' OR 'errored' are both retained: an 'errored'
    // row is an app that was meant to run but hit a possibly-transient boot
    // failure, so it must stay retryable across the next boot — selecting only
    // 'running' would unregister it forever after one transient failure (h63).
    const startupApps = new Map<string, AppConfig>();
    for (const row of store.listApps()) {
      if (row.status !== 'running' && row.status !== 'errored') continue;
      try {
        startupApps.set(row.name, validateApp(JSON.parse(row.config_json)));
      } catch (error) {
        store.updateAppStatus(row.name, 'errored');
        console.error(`[daemon] cannot restore "${row.name}":`, error);
      }
    }
    for (const app of loadedConfig?.apps ?? []) startupApps.set(app.name, app);

    // Only run the metrics HTTP server when at least one app actually enables
    // metrics; otherwise the daemon must not steal the metrics TCP port and
    // leave it unavailable to user apps (h66 / BUG CLASS F).
    const configuredMetrics = [...startupApps.values()].find(
      (app) => app.metrics?.enabled,
    )?.metrics;
    const metricsEnabled = configuredMetrics !== undefined;
    const metricsPort = configuredMetrics?.httpPort ?? DEFAULT_METRICS.httpPort ?? 9_615;

    // Reserve the metrics port as an internal port ONLY when the metrics server
    // is actually going to bind it; otherwise a metrics-disabled fleet must be
    // free to use that port for a user app (h66 — the reservation is the
    // orchestrator-side counterpart to the validator gate).
    const master = new MasterOrchestrator(metricsEnabled ? [metricsPort] : []);

    // -- Pending configs: apps started via CLI are stored here ---------------
    const pendingConfigs = new Map<string, AppConfig>();

    /** Snapshot of daemon state shared by status/dump endpoints. */
    const snapshot = () => ({
      apps: master.listApps(),
      uptime: process.uptime(),
      pid: process.pid,
    });

    // -- Build CommandContext adapter ----------------------------------------
    const ctx: CommandContext = {
      listApps: () => master.listApps(),

      getApp: (name) => {
        const status = master.getAppStatus(name);
        return status ?? undefined;
      },

      startApp: async (name) => {
        const config = pendingConfigs.get(name);
        if (!config) throw new Error(`No config found for app "${name}"`);
        // Persist desired state ONLY after the orchestrator accepts the start.
        // A rejected start (e.g. `App "..." is already running.`) must be a pure
        // no-op for persistence: the live app's (status, config_json,
        // config_path) triple stays exactly as it was (h2/h19/h32/h67).
        await master.startApp(config);
        store.saveApp(name, config);
        store.updateAppStatus(name, 'running');
        persistWorkers(store, master, name);
        pendingConfigs.delete(name);
      },

      stopApp: async (name) => {
        // Ordering is load-bearing: `master.stopApp` rejects when a child
        // survives SIGKILL, so a stop that could not actually kill its workers
        // never reaches clearWorkers and their pids stay on record for the next
        // boot's reconciliation.
        await master.stopApp(name);
        store.updateAppStatus(name, 'stopped');
        store.clearWorkers(name);
      },
      restartApp: async (name, force) => {
        try {
          await master.restartApp(name, force);
          store.updateAppStatus(name, 'running');
        } finally {
          // Persist in a finally: a restart that threw part-way has still
          // replaced some pids, and leaving the old ones on record would send
          // the next boot after SIGKILL hunting processes that no longer exist.
          persistBestEffort(store, master, name);
        }
      },
      reloadApp: async (name) => {
        try {
          await master.reloadApp(name);
        } finally {
          // A reload replaces every worker with a new pid; the persisted set
          // must follow or boot-time orphan reconciliation chases dead pids.
          persistBestEffort(store, master, name);
        }
      },
      deleteApp: async (name) => {
        await master.deleteApp(name);
        store.deleteApp(name);
      },

      getMetrics: () => {
        return master.listApps();
      },

      getLogs: (name, lines) => {
        return readLogLines(LOGS_DIR, name, lines ?? 50);
      },

      dumpState: () => snapshot(),

      shutdown: async () => {
        await master.shutdown('daemon-kill');
        process.exit(0);
      },
    };

    // -- Command handler dispatch --------------------------------------------
    const handlers = createCommandHandlers(ctx);

    controlServer = new ControlServer(socketPath, async (cmd, args) => {
      // For 'start', stash the config before the handler calls ctx.startApp
      if (cmd === 'start' && args.config) {
        const config = validateApp(args.config);
        const name = (args.name as string) || config.name;
        if (name !== config.name) {
          return createErrorResponse('', 'Request name must match config.name');
        }
        try {
          assertAppCompatibleWithDaemon(config, metricsPort, metricsEnabled);
        } catch (error) {
          return createErrorResponse('', error instanceof Error ? error.message : String(error));
        }
        pendingConfigs.set(name, config);
      }

      const handler = handlers.get(cmd);
      if (!handler) {
        return createErrorResponse('', `Unknown command: ${cmd}`);
      }
      return handler(args);
    });

    // -- Register cleanup on master shutdown ---------------------------------
    master.onShutdown(cleanup);

    // -- Signal handlers -----------------------------------------------------
    setupSignalHandlers({
      onShutdown: async (sig) => {
        console.log(`[daemon] received ${sig}, shutting down...`);
        await master.shutdown(sig);
      },
      onReload: () => {
        console.log('[daemon] received SIGHUP, reloading all apps...');
        master.reloadAll().catch((err) => {
          console.error('[daemon] reload error:', err);
        });
      },
    });

    // -- Start control server ------------------------------------------------
    await controlServer.start();
    console.log(`[daemon] control server listening on ${socketPath}`);

    // -- Start metrics HTTP server (only when some app enables metrics) ------
    if (metricsEnabled) {
      const metricsProvider: MetricsDataProvider = {
        getPrometheusMetrics: () => formatPrometheus(appStatusToMetricsInput(master.listApps())),
        getJsonMetrics: (appName) => {
          const apps = master.listApps();
          if (appName) return apps.filter((a) => a.name === appName);
          return apps;
        },
        getStatus: () => snapshot(),
      };
      metricsServer = new MetricsHttpServer(metricsPort, metricsProvider);
      try {
        metricsServer.start();
      } catch (error) {
        // Surface the port so the failure is diagnosable, then let the spanning
        // catch below release the already-bound control socket + store.
        metricsServer = null;
        throw new Error(
          `Failed to bind metrics server on port ${metricsPort}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      console.log(`[daemon] metrics server listening on http://127.0.0.1:${metricsPort}`);
    }

    // -- Restore desired running state and apply an explicit config ----------
    for (const app of startupApps.values()) {
      try {
        console.log(`[daemon] starting "${app.name}"`);
        // Reconcile any workers orphaned by a previously SIGKILLed daemon before
        // spawning a fresh generation, so restore converges to exactly
        // `instances` processes instead of stacking a new generation on top of
        // the orphans (h11).
        reconcileOrphanedWorkers(store, app.name, app.script);
        store.saveApp(app.name, app, configPath);
        await master.startApp(app);
        store.updateAppStatus(app.name, 'running');
        persistWorkers(store, master, app.name);
      } catch (error) {
        store.updateAppStatus(app.name, 'errored');
        console.error(`[daemon] failed to start "${app.name}":`, error);
      }
    }

    // Keep the persisted worker set in sync with pids that change outside any
    // control command (crash-restart, heartbeat restart, ready-timeout respawn).
    const lastSyncedWorkers = new Map<string, string>();
    let syncFailures = 0;
    let lastSyncLogAt = 0;
    workerSyncTimer = setInterval(() => {
      try {
        refreshPersistedWorkers(store, master, lastSyncedWorkers);
      } catch (error) {
        // Throttled: a permanently broken store (disk full, corrupt db) would
        // otherwise write a stack trace into the daemon log every tick, for as
        // long as the daemon lives.
        syncFailures++;
        const now = Date.now();
        if (now - lastSyncLogAt >= SYNC_ERROR_LOG_INTERVAL) {
          console.error(`[daemon] worker pid sync failed (${syncFailures} total):`, error);
          lastSyncLogAt = now;
        }
      }
    }, WORKER_SYNC_INTERVAL);
    workerSyncTimer.unref?.();

    writePidFile(pidFile, process.pid);
    console.log(`[daemon] ready (pid=${process.pid})`);
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Boot-time worker reconciliation (h11)
// ---------------------------------------------------------------------------

/**
 * Kill and forget any workers a prior daemon left behind. A daemon that dies by
 * SIGKILL cannot take its workers down with it; they are reparented to init and
 * keep running. Their PIDs are persisted after each successful start, so the
 * next boot can converge to exactly `instances` processes per app.
 */
function reconcileOrphanedWorkers(store: SqliteStore, appName: string, script: string): void {
  for (const worker of store.getWorkers(appName)) {
    // Only kill a PID we can positively identify as still being THIS app's
    // worker (its command line runs this exact script). Between the old daemon's
    // death and this boot the OS may have reused the PID for an unrelated
    // process; a bare liveness check would then SIGKILL that innocent process.
    if (worker.pid && isBunpilotWorkerProcess(worker.pid, script)) {
      try {
        process.kill(worker.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
  store.clearWorkers(appName);
}

/** Persist the PIDs of an app's freshly-spawned workers for later reconciliation. */
function persistWorkers(store: SqliteStore, master: MasterOrchestrator, appName: string): void {
  const status = master.getAppStatus(appName);
  if (!status) return;
  store.replaceWorkers(
    appName,
    status.workers.map((worker) => ({
      id: worker.id,
      state: worker.state,
      pid: worker.pid || undefined,
    })),
  );
}

/**
 * `persistWorkers` for use inside a `finally`.
 *
 * A throw out of a `finally` REPLACES the in-flight exception, so a SQLITE_BUSY
 * / SQLITE_FULL here would both hide the real restart failure and turn a
 * SUCCESSFUL restart into a reported failure. Persistence is bookkeeping: it
 * must never decide the outcome of the command it is recording.
 */
function persistBestEffort(store: SqliteStore, master: MasterOrchestrator, appName: string): void {
  try {
    persistWorkers(store, master, appName);
  } catch (error) {
    console.error(`[daemon] failed to persist workers for "${appName}":`, error);
  }
}

/**
 * Re-persist every app's live worker PIDs.
 *
 * Lifecycle commands persist at their own boundaries, but a crash-restart, a
 * heartbeat-triggered restart or a ready-timeout respawn happens with no
 * command in flight and silently changes a worker's pid. Left unrefreshed, the
 * `workers` table goes stale and the next boot after a SIGKILLed daemon fails
 * to identify (and therefore fails to kill) the real orphans.
 */
function refreshPersistedWorkers(
  store: SqliteStore,
  master: MasterOrchestrator,
  lastSynced: Map<string, string>,
): void {
  const seen = new Set<string>();
  for (const app of master.listApps()) {
    // Only running apps. A stopped app keeps its (dead) worker entries in
    // memory, so refreshing it would silently undo the clearWorkers() that
    // `stop` just performed and hand the next boot a set of dead pids.
    if (app.status !== 'running') continue;
    // Never persist an empty worker set for a running app: it would erase the
    // pids of a generation that may still be alive, which is exactly what
    // boot-time reconciliation needs to find. `restartApp` does clear the array
    // before respawning, but with no await in between, so a timer callback
    // cannot currently sample that window — this is insurance against a future
    // await landing there, not a live hazard.
    if (app.workers.length === 0) continue;
    // Dirty check: an idle daemon must not run a DELETE + N INSERT transaction
    // every tick forever just to rewrite identical rows.
    const signature = app.workers.map((w) => `${w.id}:${w.state}:${w.pid ?? ''}`).join(',');
    seen.add(app.name);
    if (lastSynced.get(app.name) === signature) continue;
    persistWorkers(store, master, app.name);
    lastSynced.set(app.name, signature);
  }
  // Bounded memory: without this the map keeps one entry per app name for the
  // daemon's whole life, across arbitrary create/delete churn. Correctness does
  // not depend on it — every transition into 'running' persists at its own
  // boundary (startApp / restartApp / reloadApp), so a stale entry could only
  // ever skip a write the store already has.
  for (const name of lastSynced.keys()) {
    if (!seen.has(name)) lastSynced.delete(name);
  }
}

// ---------------------------------------------------------------------------
// AppStatus -> AppMetricsInput adapter
// ---------------------------------------------------------------------------

function appStatusToMetricsInput(apps: AppStatus[]): AppMetricsInput[] {
  return apps.map((app) => ({
    appName: app.name,
    workers: app.workers.map((w): AppWorkerMetrics => {
      const uptimeSeconds = (Date.now() - w.startedAt) / 1000;
      return {
        // Use the stable slot so the exposed label is bounded across reloads.
        workerId: w.slot ?? w.id,
        metrics: w.memory
          ? {
              memory: {
                rss: w.memory.rss,
                heapTotal: w.memory.heapTotal,
                heapUsed: w.memory.heapUsed,
                external: w.memory.external,
                arrayBuffers: w.memory.arrayBuffers,
              },
              cpuPercent: w.cpu?.percentage ?? 0,
              timestamp: w.memory.timestamp,
              telemetry: w.telemetry ?? null,
            }
          : null,
        restartCount: w.restartCount,
        uptime: uptimeSeconds,
        state: w.state,
      };
    }),
  }));
}
