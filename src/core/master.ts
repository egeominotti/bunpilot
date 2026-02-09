// ---------------------------------------------------------------------------
// bunpilot – Master Orchestrator
// ---------------------------------------------------------------------------

import { cpus } from 'node:os';
import type { AppConfig, AppStatus, WorkerInfo } from '../config/types';
import { DEFAULT_LOGS, PORT_RELEASE_DELAY } from '../constants';
import { LogManager } from '../logs/manager';
import { HealthChecker } from '../health/checker';
import { ProxyCluster } from '../cluster/proxy';
import { detectStrategy } from '../cluster/platform';
import { ProcessManager } from './process-manager';
import { CrashRecovery } from './backoff';
import { WorkerLifecycle } from './lifecycle';
import { ReloadHandler } from './reload-handler';
import { WorkerHandler, type ManagedApp } from './worker-handler';

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
          this.restartWorker(managed, worker);
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

    const instances = this.resolveInstances(config.instances);
    const managed: ManagedApp = {
      config: { ...config, instances },
      workers: [],
      spawned: new Map(),
      startedAt: Date.now(),
      stableTimers: new Map(),
      nextWorkerId: instances,
    };
    this.apps.set(config.name, managed);

    // Start proxy if needed (proxy strategy, clustered, with a port).
    if (this.shouldUseProxy(managed.config, instances)) {
      const proxy = this.createProxyCluster();
      proxy.start(managed.config.port!, instances);
      this.proxies.set(config.name, proxy);
    }

    for (let i = 0; i < instances; i++) {
      this.spawnWorker(managed, i);
    }
  }

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  async stopApp(name: string): Promise<void> {
    const managed = this.getManaged(name);

    // Stop health monitoring for all workers before killing them.
    for (const worker of managed.workers) {
      this.healthChecker.stopChecking(worker.id);
      this.healthChecker.stopHeartbeatMonitor(worker.id);
    }

    await this.workerHandler.stopAllWorkers(managed);
    managed.startedAt = null;

    // Stop proxy if present.
    this.proxies.get(name)?.stop();
    this.proxies.delete(name);
  }

  // -----------------------------------------------------------------------
  // Restart (hard)
  // -----------------------------------------------------------------------

  async restartApp(name: string, _force = false): Promise<void> {
    const managed = this.getManaged(name);

    // Bug 7 fix: Stop health checking and heartbeat monitoring before reset.
    for (const worker of managed.workers) {
      this.healthChecker.stopChecking(worker.id);
      this.healthChecker.stopHeartbeatMonitor(worker.id);
    }

    await this.workerHandler.stopAllWorkers(managed);

    // Stop old proxy before respawning.
    this.proxies.get(name)?.stop();
    this.proxies.delete(name);

    // Bug 6 fix: Clear stable timers and backoff timers from old generation.
    this.workerHandler.cleanupApp(managed);

    const instances = this.resolveInstances(managed.config.instances);

    // Allow the OS to release ports before spawning new workers.
    // Needed for any app with a port (public or internal) to avoid EADDRINUSE.
    if (managed.config.port) {
      await new Promise((resolve) => setTimeout(resolve, PORT_RELEASE_DELAY));
    }

    managed.workers = [];
    managed.spawned.clear();
    managed.startedAt = Date.now();
    managed.nextWorkerId = instances;

    // Create new proxy if needed.
    if (this.shouldUseProxy(managed.config, instances)) {
      const proxy = this.createProxyCluster();
      proxy.start(managed.config.port!, instances);
      this.proxies.set(name, proxy);
    }

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

    await this.reloadHandler.rollingRestart({
      config: managed.config,
      workers: currentWorkers,
      processManager: this.processManager,
      lifecycle: this.lifecycle,
      spawnAndTrack: (_cfg, _wid) => {
        const newId = managed.nextWorkerId++;
        return this.spawnWorker(managed, newId);
      },
      drainAndStop: (w) => {
        this.proxies.get(managed.config.name)?.removeWorker(w.id);
        return this.workerHandler.drainAndStopWorker(managed, w);
      },
    });
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  async deleteApp(name: string): Promise<void> {
    const managed = this.apps.get(name);
    if (managed) {
      // Stop health monitoring for all workers before killing them.
      for (const worker of managed.workers) {
        this.healthChecker.stopChecking(worker.id);
        this.healthChecker.stopHeartbeatMonitor(worker.id);
      }

      await this.workerHandler.stopAllWorkers(managed);
      this.workerHandler.cleanupApp(managed);

      // Stop proxy if present.
      this.proxies.get(name)?.stop();
      this.proxies.delete(name);

      this.apps.delete(name);
    }
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  listApps(): AppStatus[] {
    const result: AppStatus[] = [];
    for (const [, managed] of this.apps) {
      result.push(this.toAppStatus(managed));
    }
    return result;
  }

  getAppStatus(name: string): AppStatus | null {
    const managed = this.apps.get(name);
    return managed ? this.toAppStatus(managed) : null;
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
    const worker = this.createWorkerInfo(workerId);
    managed.workers.push(worker);

    this.workerHandler.transitionWorker(worker, 'starting');

    const spawned = this.processManager.spawnWorker(
      managed.config,
      workerId,
      (wid, msg) => {
        this.workerHandler.handleMessage(managed, wid, msg);
        if (msg.type === 'ready') {
          this.proxies.get(managed.config.name)?.addWorker(wid);
        }
        if (msg.type === 'heartbeat') {
          this.healthChecker.onHeartbeat(wid);
        }
      },
      (wid, code, sig) => {
        this.proxies.get(managed.config.name)?.removeWorker(wid);
        this.workerHandler.handleExit(managed, wid, code, sig, (m, w) => this.restartWorker(m, w));
      },
    );

    worker.pid = spawned.pid;
    managed.spawned.set(workerId, spawned);
    this.workerHandler.scheduleStableCheck(managed, worker);

    // Start health checking and heartbeat monitoring for the new worker.
    this.healthChecker.startChecking(workerId, managed.config);
    this.healthChecker.startHeartbeatMonitor(workerId, (wid) => {
      console.warn(`[master] worker ${wid} heartbeat stale`);
      this.healthChecker.stopChecking(wid);
      this.healthChecker.stopHeartbeatMonitor(wid);
      const w = this.workerHandler.findWorker(managed, wid);
      if (w && (w.state === 'online' || w.state === 'starting')) {
        this.restartWorker(managed, w);
      }
    });

    // Pipe stdout/stderr to log files
    const logsConfig = managed.config.logs ?? DEFAULT_LOGS;
    const isDaemon = !!process.env.BUNPILOT_DAEMON;
    this.logManager.pipeOutput(
      managed.config.name,
      workerId,
      spawned.stdout,
      spawned.stderr,
      logsConfig,
      !isDaemon,
    );

    return worker;
  }

  private restartWorker(managed: ManagedApp, worker: WorkerInfo): void {
    // Bug 2 fix: Kill old process before spawning replacement.
    const oldSpawned = managed.spawned.get(worker.id);
    if (oldSpawned && this.processManager.isRunning(oldSpawned.pid)) {
      this.processManager.killWorker(
        oldSpawned.pid,
        managed.config.shutdownSignal,
        managed.config.killTimeout,
      );
    }

    // Bug 3 fix: For non-standard restart paths (online/starting -> spawning),
    // force the state to 'stopped' first so the transition to 'spawning' is valid.
    if (!this.workerHandler.transitionWorker(worker, 'spawning')) {
      worker.state = 'stopped';
      this.workerHandler.transitionWorker(worker, 'spawning');
    }

    worker.restartCount += 1;
    managed.spawned.delete(worker.id);

    this.workerHandler.transitionWorker(worker, 'starting');

    const spawned = this.processManager.spawnWorker(
      managed.config,
      worker.id,
      (wid, msg) => {
        this.workerHandler.handleMessage(managed, wid, msg);
        if (msg.type === 'ready') {
          this.proxies.get(managed.config.name)?.addWorker(wid);
        }
        if (msg.type === 'heartbeat') {
          this.healthChecker.onHeartbeat(wid);
        }
      },
      (wid, code, sig) => {
        this.proxies.get(managed.config.name)?.removeWorker(wid);
        this.workerHandler.handleExit(managed, wid, code, sig, (m, w) => this.restartWorker(m, w));
      },
    );

    worker.pid = spawned.pid;
    worker.startedAt = Date.now();
    worker.readyAt = null;
    worker.exitCode = null;
    worker.signalCode = null;
    managed.spawned.set(worker.id, spawned);

    this.workerHandler.scheduleStableCheck(managed, worker);

    // Start health checking and heartbeat monitoring for the restarted worker.
    this.healthChecker.startChecking(worker.id, managed.config);
    this.healthChecker.startHeartbeatMonitor(worker.id, (wid) => {
      console.warn(`[master] worker ${wid} heartbeat stale`);
      this.healthChecker.stopChecking(wid);
      this.healthChecker.stopHeartbeatMonitor(wid);
      const w = this.workerHandler.findWorker(managed, wid);
      if (w && (w.state === 'online' || w.state === 'starting')) {
        this.restartWorker(managed, w);
      }
    });

    // Pipe stdout/stderr to log files
    const logsConfig = managed.config.logs ?? DEFAULT_LOGS;
    const isDaemon = !!process.env.BUNPILOT_DAEMON;
    this.logManager.pipeOutput(
      managed.config.name,
      worker.id,
      spawned.stdout,
      spawned.stderr,
      logsConfig,
      !isDaemon,
    );
  }

  // -----------------------------------------------------------------------
  // Utility
  // -----------------------------------------------------------------------

  private resolveInstances(value: number | 'max'): number {
    return value === 'max' ? cpus().length : value;
  }

  private createWorkerInfo(workerId: number): WorkerInfo {
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

  private getManaged(name: string): ManagedApp {
    const managed = this.apps.get(name);
    if (!managed) {
      throw new Error(`App "${name}" not found.`);
    }
    return managed;
  }

  /** Check whether an app should use the TCP proxy cluster. */
  private shouldUseProxy(config: AppConfig, instances: number): boolean {
    if (!config.clustering?.enabled) return false;
    if (instances <= 1) return false;
    if (config.port === undefined) return false;
    return detectStrategy(config.clustering.strategy ?? 'auto') === 'proxy';
  }

  /** Factory method for ProxyCluster — overridden in tests. */
  private createProxyCluster(): ProxyCluster {
    return new ProxyCluster();
  }

  private toAppStatus(managed: ManagedApp): AppStatus {
    const hasOnline = managed.workers.some((w) => w.state === 'online');
    const allStopped = managed.workers.every((w) => w.state === 'stopped' || w.state === 'errored');
    const hasErrored = managed.workers.some((w) => w.state === 'errored');

    let status: AppStatus['status'];
    if (managed.workers.length === 0) {
      status = managed.startedAt ? 'running' : 'stopped';
    } else if (allStopped) {
      status = hasErrored ? 'errored' : 'stopped';
    } else if (hasOnline) {
      status = 'running';
    } else {
      status = 'running';
    }

    return {
      name: managed.config.name,
      status,
      workers: [...managed.workers],
      config: managed.config,
      startedAt: managed.startedAt,
    };
  }
}
