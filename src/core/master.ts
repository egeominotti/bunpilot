// ---------------------------------------------------------------------------
// bunpilot – Master Orchestrator
// ---------------------------------------------------------------------------

import type { AppConfig, AppStatus, WorkerInfo } from '../config/types';
import { PORT_RELEASE_DELAY } from '../constants';
import { LogManager } from '../logs/manager';
import { HealthChecker } from '../health/checker';
import { ProxyCluster } from '../cluster/proxy';
import { resolveInstances, shouldUseProxy } from '../cluster/policy';
import { ProcessManager } from './process-manager';
import { CrashRecovery } from './backoff';
import { WorkerLifecycle } from './lifecycle';
import { ReloadHandler } from './reload-handler';
import { WorkerHandler, type ManagedApp } from './worker-handler';
import { createWorkerInfo, toAppStatus } from './app-status';
import { launchWorker, scheduleRestart, type LaunchDeps } from './worker-launch';

// ---------------------------------------------------------------------------
// MasterOrchestrator
// ---------------------------------------------------------------------------

export class MasterOrchestrator {
  private readonly apps = new Map<string, ManagedApp>();
  private readonly proxies = new Map<string, ProxyCluster>();
  private readonly processManager = new ProcessManager();
  private readonly crashRecovery = new CrashRecovery();
  private readonly lifecycle = new WorkerLifecycle();
  private readonly reloadHandler = new ReloadHandler();
  private readonly workerHandler: WorkerHandler;
  private readonly logManager = new LogManager();
  private readonly healthChecker = new HealthChecker();
  private readonly shutdownCallbacks: Array<() => void | Promise<void>> = [];

  constructor() {
    this.workerHandler = new WorkerHandler(this.processManager, this.crashRecovery, this.lifecycle);

    // When a worker is deemed unhealthy, find its app and restart it.
    this.healthChecker.onUnhealthy((workerId, reason) => {
      console.warn(`[master] worker ${workerId} unhealthy: ${reason}`);
      for (const [, managed] of this.apps) {
        const worker = this.workerHandler.findWorker(managed, workerId);
        if (worker && (worker.state === 'online' || worker.state === 'starting')) {
          this.healthChecker.stopChecking(workerId);
          this.healthChecker.stopHeartbeatMonitor(workerId);
          scheduleRestart(this.launchDeps(), managed, worker);
          break;
        }
      }
    });
  }

  /** Register a callback to run during shutdown (for cleaning up external resources). */
  onShutdown(cb: () => void | Promise<void>): void {
    this.shutdownCallbacks.push(cb);
  }

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------

  async startApp(config: AppConfig): Promise<void> {
    if (this.apps.has(config.name)) {
      throw new Error(`App "${config.name}" is already running.`);
    }

    const instances = resolveInstances(config.instances);
    const managed: ManagedApp = {
      config: { ...config, instances },
      workers: [],
      spawned: new Map(),
      startedAt: Date.now(),
      stableTimers: new Map(),
      nextWorkerId: instances,
    };
    this.apps.set(config.name, managed);

    // H2 fix: if proxy startup or any spawn throws, roll back the registration
    // so the app name isn't left wedged (and partial resources don't leak).
    try {
      this.startProxyIfNeeded(config.name, managed.config, instances);
      for (let i = 0; i < instances; i++) {
        this.spawnWorker(managed, i);
      }
    } catch (err) {
      await this.rollbackApp(config.name, managed);
      throw err;
    }
  }

  /** Tear down a partially-started app and remove it from the registry. */
  private async rollbackApp(name: string, managed: ManagedApp): Promise<void> {
    this.stopWorkerMonitors(managed);
    await this.workerHandler.stopAllWorkers(managed);
    this.workerHandler.cleanupApp(managed);
    this.stopProxy(name);
    this.apps.delete(name);
  }

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  async stopApp(name: string): Promise<void> {
    const managed = this.getManaged(name);

    this.stopWorkerMonitors(managed);
    await this.workerHandler.stopAllWorkers(managed);
    managed.startedAt = null;
    this.stopProxy(name);
  }

  // -----------------------------------------------------------------------
  // Restart (hard)
  // -----------------------------------------------------------------------

  async restartApp(name: string, _force = false): Promise<void> {
    const managed = this.getManaged(name);

    // Bug 7 fix: Stop health checking and heartbeat monitoring before reset.
    this.stopWorkerMonitors(managed);
    await this.workerHandler.stopAllWorkers(managed);

    // Stop old proxy before respawning.
    this.stopProxy(name);

    // Bug 6 fix: Clear stable timers and backoff timers from old generation.
    this.workerHandler.cleanupApp(managed);

    const instances = resolveInstances(managed.config.instances);

    // Allow the OS to release ports before spawning new workers.
    // Needed for any app with a port (public or internal) to avoid EADDRINUSE.
    if (managed.config.port) {
      await this.sleep(PORT_RELEASE_DELAY);
    }

    managed.workers = [];
    managed.spawned.clear();
    managed.startedAt = Date.now();
    managed.nextWorkerId = instances;

    this.startProxyIfNeeded(name, managed.config, instances);
    for (let i = 0; i < instances; i++) {
      this.spawnWorker(managed, i);
    }
  }

  // -----------------------------------------------------------------------
  // Reload (zero-downtime)
  // -----------------------------------------------------------------------

  async reloadApp(name: string): Promise<void> {
    const managed = this.getManaged(name);
    const currentWorkers = [...managed.workers];
    const replacements: WorkerInfo[] = [];

    try {
      await this.reloadHandler.rollingRestart({
        config: managed.config,
        workers: currentWorkers,
        processManager: this.processManager,
        lifecycle: this.lifecycle,
        spawnAndTrack: (_cfg, _wid) => {
          const newId = managed.nextWorkerId++;
          const worker = this.spawnWorker(managed, newId);
          replacements.push(worker);
          return worker;
        },
        drainAndStop: async (w) => {
          this.proxies.get(managed.config.name)?.removeWorker(w.id);
          await this.workerHandler.drainAndStopWorker(managed, w);
          // H1 fix: remove the drained worker from the managed list and tear
          // down its monitors/timers — otherwise every reload leaks a ghost.
          this.retireWorker(managed, w);
        },
      });
    } catch (err) {
      // H3 fix: a replacement failed to come up. Retire any replacement that
      // never reached 'online' so a crashed worker can't linger in the managed
      // list or auto-restart via its own backoff timer. Old workers are left
      // untouched (capacity preserved) and the error is surfaced.
      for (const r of replacements) {
        if (r.state !== 'online') {
          this.proxies.get(managed.config.name)?.removeWorker(r.id);
          await this.workerHandler.drainAndStopWorker(managed, r);
          this.retireWorker(managed, r);
        }
      }
      throw err;
    }
  }

  /** Remove a fully-drained worker and release all of its per-worker state. */
  private retireWorker(managed: ManagedApp, worker: WorkerInfo): void {
    this.healthChecker.stopChecking(worker.id);
    this.healthChecker.stopHeartbeatMonitor(worker.id);
    this.workerHandler.clearStableTimer(managed, worker.id);
    this.workerHandler.clearBackoffTimer(worker.id);
    this.crashRecovery.reset(worker.id);
    const idx = managed.workers.indexOf(worker);
    if (idx !== -1) managed.workers.splice(idx, 1);
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  async deleteApp(name: string): Promise<void> {
    const managed = this.apps.get(name);
    if (managed) {
      this.stopWorkerMonitors(managed);
      await this.workerHandler.stopAllWorkers(managed);
      this.workerHandler.cleanupApp(managed);
      this.stopProxy(name);
      this.apps.delete(name);
    }
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  listApps(): AppStatus[] {
    const result: AppStatus[] = [];
    for (const [, managed] of this.apps) {
      result.push(toAppStatus(managed));
    }
    return result;
  }

  getAppStatus(name: string): AppStatus | null {
    const managed = this.apps.get(name);
    return managed ? toAppStatus(managed) : null;
  }

  // -----------------------------------------------------------------------
  // Global shutdown / reload
  // -----------------------------------------------------------------------

  async shutdown(_signal: string): Promise<void> {
    // Stop all health monitors first.
    this.healthChecker.stopAll();

    // Stop all proxies.
    for (const proxy of this.proxies.values()) {
      proxy.stop();
    }
    this.proxies.clear();

    const names = [...this.apps.keys()];
    await Promise.all(names.map((n) => this.stopApp(n)));

    // Clean up managed resources
    this.logManager.closeAll();

    // Run externally registered cleanup callbacks
    for (const cb of this.shutdownCallbacks) {
      try {
        await cb();
      } catch (err) {
        console.error('[master] shutdown cleanup error:', err);
      }
    }
  }

  async reloadAll(): Promise<void> {
    const names = [...this.apps.keys()];
    for (const name of names) {
      await this.reloadApp(name);
    }
  }

  // -----------------------------------------------------------------------
  // Spawn
  // -----------------------------------------------------------------------

  private spawnWorker(managed: ManagedApp, workerId: number): WorkerInfo {
    const worker = createWorkerInfo(workerId);
    managed.workers.push(worker);

    this.workerHandler.transitionWorker(worker, 'starting');
    launchWorker(this.launchDeps(), managed, worker);

    return worker;
  }

  /** Collaborators for the launcher, read live so test stubs are honoured. */
  private launchDeps(): LaunchDeps {
    return {
      processManager: this.processManager,
      healthChecker: this.healthChecker,
      logManager: this.logManager,
      workerHandler: this.workerHandler,
      getProxy: (name) => this.proxies.get(name),
    };
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  private getManaged(name: string): ManagedApp {
    const managed = this.apps.get(name);
    if (!managed) {
      throw new Error(`App "${name}" not found.`);
    }
    return managed;
  }

  /** Stop HTTP + heartbeat monitoring for every worker of an app. */
  private stopWorkerMonitors(managed: ManagedApp): void {
    for (const worker of managed.workers) {
      this.healthChecker.stopChecking(worker.id);
      this.healthChecker.stopHeartbeatMonitor(worker.id);
    }
  }

  /** Start the TCP proxy for an app when its strategy requires one. */
  private startProxyIfNeeded(name: string, config: AppConfig, instances: number): void {
    if (!shouldUseProxy(config, instances)) return;
    const proxy = this.createProxyCluster();
    proxy.start(config.port!, instances);
    this.proxies.set(name, proxy);
  }

  /** Stop and forget an app's proxy, if it has one. */
  private stopProxy(name: string): void {
    this.proxies.get(name)?.stop();
    this.proxies.delete(name);
  }

  /** Factory method for ProxyCluster — overridden in tests. */
  private createProxyCluster(): ProxyCluster {
    return new ProxyCluster();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
