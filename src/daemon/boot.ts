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
import { removePidFile, writePidFile } from './pid';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Reject listener collisions for apps submitted after the daemon has started. */
export function assertAppCompatibleWithDaemon(config: AppConfig, metricsPort: number): void {
  if (config.port === metricsPort) {
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

  const store = new SqliteStore();
  const configuredMetrics = loadedConfig?.apps.find((app) => app.metrics?.enabled)?.metrics;
  const metricsPort = configuredMetrics?.httpPort ?? DEFAULT_METRICS.httpPort ?? 9_615;
  const master = new MasterOrchestrator([metricsPort]);
  const socketPath = resolve(loadedConfig?.daemon?.socketFile ?? SOCKET_PATH);
  const pidFile = resolve(loadedConfig?.daemon?.pidFile ?? PID_FILE);

  // -- Pending configs: apps started via CLI are stored here -----------------
  const pendingConfigs = new Map<string, AppConfig>();

  /** Snapshot of daemon state shared by status/dump endpoints. */
  const snapshot = () => ({ apps: master.listApps(), uptime: process.uptime(), pid: process.pid });

  // -- Build CommandContext adapter ------------------------------------------
  const ctx: CommandContext = {
    listApps: () => master.listApps(),

    getApp: (name) => {
      const status = master.getAppStatus(name);
      return status ?? undefined;
    },

    startApp: async (name) => {
      const config = pendingConfigs.get(name);
      if (!config) throw new Error(`No config found for app "${name}"`);
      store.saveApp(name, config);
      try {
        await master.startApp(config);
        store.updateAppStatus(name, 'running');
        pendingConfigs.delete(name);
      } catch (error) {
        store.updateAppStatus(name, 'stopped');
        throw error;
      }
    },

    stopApp: async (name) => {
      await master.stopApp(name);
      store.updateAppStatus(name, 'stopped');
    },
    restartApp: async (name, force) => {
      await master.restartApp(name, force);
      store.updateAppStatus(name, 'running');
    },
    reloadApp: (name) => master.reloadApp(name),
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

  // -- Command handler dispatch ----------------------------------------------
  const handlers = createCommandHandlers(ctx);

  const controlServer = new ControlServer(socketPath, async (cmd, args) => {
    // For 'start', stash the config before the handler calls ctx.startApp
    if (cmd === 'start' && args.config) {
      const config = validateApp(args.config);
      const name = (args.name as string) || config.name;
      if (name !== config.name) {
        return createErrorResponse('', 'Request name must match config.name');
      }
      try {
        assertAppCompatibleWithDaemon(config, metricsPort);
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

  // -- Metrics HTTP server ----------------------------------------------------
  const metricsProvider: MetricsDataProvider = {
    getPrometheusMetrics: () => formatPrometheus(appStatusToMetricsInput(master.listApps())),
    getJsonMetrics: (appName) => {
      const apps = master.listApps();
      if (appName) return apps.filter((a) => a.name === appName);
      return apps;
    },
    getStatus: () => snapshot(),
  };

  const metricsServer = new MetricsHttpServer(metricsPort, metricsProvider);

  // -- Register cleanup on master shutdown -----------------------------------
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    for (const [label, action] of [
      ['control server', () => controlServer.stop()],
      ['metrics server', () => metricsServer.stop()],
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
  master.onShutdown(cleanup);

  // -- Signal handlers -------------------------------------------------------
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

  // -- Start control server --------------------------------------------------
  await controlServer.start();
  console.log(`[daemon] control server listening on ${socketPath}`);

  // -- Start metrics HTTP server ---------------------------------------------
  metricsServer.start();
  console.log(`[daemon] metrics server listening on http://127.0.0.1:${metricsPort}`);

  // -- Restore desired running state and apply an explicit config ------------
  const startupApps = new Map<string, AppConfig>();
  for (const row of store.listApps()) {
    if (row.status !== 'running') continue;
    try {
      startupApps.set(row.name, validateApp(JSON.parse(row.config_json)));
    } catch (error) {
      store.updateAppStatus(row.name, 'errored');
      console.error(`[daemon] cannot restore "${row.name}":`, error);
    }
  }
  for (const app of loadedConfig?.apps ?? []) startupApps.set(app.name, app);

  for (const app of startupApps.values()) {
    try {
      console.log(`[daemon] starting "${app.name}"`);
      store.saveApp(app.name, app, configPath);
      await master.startApp(app);
      store.updateAppStatus(app.name, 'running');
    } catch (error) {
      store.updateAppStatus(app.name, 'errored');
      console.error(`[daemon] failed to start "${app.name}":`, error);
    }
  }

  writePidFile(pidFile, process.pid);
  console.log(`[daemon] ready (pid=${process.pid})`);
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
        workerId: w.id,
        metrics: w.memory
          ? {
              memory: {
                rss: w.memory.rss,
                heapTotal: w.memory.heapTotal,
                heapUsed: w.memory.heapUsed,
                external: w.memory.external,
              },
              cpuPercent: w.cpu?.percentage ?? 0,
              timestamp: w.memory.timestamp,
            }
          : null,
        restartCount: w.restartCount,
        uptime: uptimeSeconds,
        state: w.state,
      };
    }),
  }));
}
