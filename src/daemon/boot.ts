#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// bunpilot – Daemon Boot: entry point spawned by daemonize()
// ---------------------------------------------------------------------------
//
// This script is the actual process that runs in the background.
// It wires up: MasterOrchestrator + ControlServer + SignalHandlers.
// ---------------------------------------------------------------------------

import { MasterOrchestrator } from '../core/master';
import { ControlServer } from '../control/server';
import { createCommandHandlers, type CommandContext } from '../control/handlers';
import { setupSignalHandlers } from '../core/signals';
import { loadConfig } from '../config/loader';
import { ensureBunpilotHome, SOCKET_PATH, LOGS_DIR } from '../constants';
import { mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig, AppStatus } from '../config/types';
import { createErrorResponse } from '../control/protocol';
import { SqliteStore } from '../store/sqlite';
import { MetricsHttpServer, type MetricsDataProvider } from '../metrics/http-server';
import {
  formatPrometheus,
  type AppMetricsInput,
  type AppWorkerMetrics,
} from '../metrics/prometheus';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureBunpilotHome();
  mkdirSync(LOGS_DIR, { recursive: true });

  const store = new SqliteStore();
  const master = new MasterOrchestrator();

  // -- Pending configs: apps started via CLI are stored here -----------------
  const pendingConfigs = new Map<string, AppConfig>();

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
      pendingConfigs.delete(name);
      store.saveApp(name, config);
      await master.startApp(config);
    },

    stopApp: (name) => {
      store.updateAppStatus(name, 'stopped');
      return master.stopApp(name);
    },
    restartApp: (name) => master.restartApp(name),
    reloadApp: (name) => master.reloadApp(name),
    deleteApp: (name) => {
      store.deleteApp(name);
      return master.deleteApp(name);
    },

    getMetrics: () => {
      return master.listApps();
    },

    getLogs: (name, lines) => {
      return readLogLines(name, lines ?? 50);
    },

    dumpState: () => {
      const apps = master.listApps();
      return { apps, uptime: process.uptime(), pid: process.pid };
    },

    shutdown: async () => {
      await master.shutdown('daemon-kill');
      controlServer.stop();
      metricsServer.stop();
      store.close();
      process.exit(0);
    },
  };

  // -- Command handler dispatch ----------------------------------------------
  const handlers = createCommandHandlers(ctx);

  const controlServer = new ControlServer(SOCKET_PATH, async (cmd, args) => {
    // For 'start', stash the config before the handler calls ctx.startApp
    if (cmd === 'start' && args.config) {
      const config = args.config as AppConfig;
      const name = (args.name as string) || config.name;
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
    getStatus: () => ({ apps: master.listApps(), uptime: process.uptime(), pid: process.pid }),
  };

  const metricsServer = new MetricsHttpServer(9615, metricsProvider);

  // -- Register cleanup on master shutdown -----------------------------------
  master.onShutdown(() => {
    controlServer.stop();
    metricsServer.stop();
    store.close();
  });

  // -- Signal handlers -------------------------------------------------------
  setupSignalHandlers({
    onShutdown: async (sig) => {
      console.log(`[daemon] received ${sig}, shutting down...`);
      await master.shutdown(sig);
      controlServer.stop();
      metricsServer.stop();
      store.close();
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
  console.log(`[daemon] control server listening on ${SOCKET_PATH}`);

  // -- Start metrics HTTP server ---------------------------------------------
  metricsServer.start();
  console.log('[daemon] metrics server listening on http://127.0.0.1:9615');

  // -- Load config if passed as argument -------------------------------------
  const configPath = process.argv[2];
  if (configPath) {
    try {
      const bunpilotConfig = await loadConfig(configPath);
      for (const app of bunpilotConfig.apps) {
        console.log(`[daemon] auto-starting "${app.name}" from config`);
        await master.startApp(app);
      }
    } catch {
      // Config loading is optional — daemon can run empty
      console.log('[daemon] no config loaded, waiting for commands...');
    }
  }

  console.log(`[daemon] ready (pid=${process.pid})`);
}

main().catch((err) => {
  console.error('[daemon] fatal error:', err);
  process.exit(1);
});

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

// ---------------------------------------------------------------------------
// Log file reader
// ---------------------------------------------------------------------------

function readLogLines(appName: string, maxLines: number): string[] {
  const appDir = join(LOGS_DIR, appName);
  if (!existsSync(appDir)) return [];

  const files = readdirSync(appDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => join(appDir, f));

  if (files.length === 0) return [];

  const allLines: string[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n').filter((l) => l.length > 0);
      allLines.push(...lines);
    } catch {
      // File may have been rotated/deleted
    }
  }

  // Return last N lines
  return allLines.slice(-maxLines);
}
