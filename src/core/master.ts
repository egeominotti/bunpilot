// ---------------------------------------------------------------------------
// bunpilot – Master Orchestrator
// ---------------------------------------------------------------------------

import { resolveInstances, shouldUseProxy } from '../cluster/policy';
import { ProxyCluster } from '../cluster/proxy';
import type { AppConfig, AppStatus, WorkerInfo } from '../config/types';
import { INTERNAL_PORT_BASE, PORT_RELEASE_DELAY } from '../constants';
import { HealthChecker } from '../health/checker';
import { LogManager } from '../logs/manager';
import { createWorkerInfo, toAppStatus } from './app-status';
import { CrashRecovery } from './backoff';
import { WorkerLifecycle } from './lifecycle';
import { ProcessManager } from './process-manager';
import { ReloadHandler } from './reload-handler';
import { type ManagedApp, WorkerHandler } from './worker-handler';
import { type LaunchDeps, launchWorker, scheduleRestart } from './worker-launch';

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
  private readonly allocatedInternalPorts = new Set<number>();
  private readonly operationQueues = new Map<string, Promise<void>>();
  private shutdownPromise: Promise<void> | null = null;
  /** Once true, no new app may be started/restarted/reloaded (shutdown is authoritative). */
  private shuttingDown = false;

  constructor(reservedPorts: Iterable<number> = []) {
    for (const port of reservedPorts) {
      if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
        this.allocatedInternalPorts.add(port);
      }
    }
    this.workerHandler = new WorkerHandler(this.processManager, this.crashRecovery, this.lifecycle);

    // When a worker is deemed unhealthy, find its app and restart it.
    this.healthChecker.onUnhealthy((workerId, reason, namespace) => {
      console.warn(`[master] worker ${workerId} unhealthy: ${reason}`);
      const candidates = namespace ? [this.apps.get(namespace)] : [...this.apps.values()];
      for (const managed of candidates) {
        if (!managed) continue;
        const worker = this.workerHandler.findWorker(managed, workerId);
        if (worker && (worker.state === 'online' || worker.state === 'starting')) {
          this.healthChecker.stopChecking(workerId, managed.config.name);
          this.healthChecker.stopHeartbeatMonitor(workerId, managed.config.name);
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

  startApp(config: AppConfig): Promise<void> {
    return this.withAppLock(config.name, () => this.startAppUnlocked(config));
  }

  private async startAppUnlocked(config: AppConfig): Promise<void> {
    // Shutdown is authoritative: a control command that lands inside the
    // shutdown window must not spawn workers the daemon will then orphan (h46).
    if (this.shuttingDown) {
      throw new Error('Cannot start an app while the daemon is shutting down.');
    }
    if (this.apps.has(config.name)) {
      throw new Error(`App "${config.name}" is already running.`);
    }
    this.assertPublicPortAvailable(config);

    const instances = resolveInstances(config.instances);
    const managed: ManagedApp = {
      config: { ...config, instances },
      workers: [],
      spawned: new Map(),
      startedAt: Date.now(),
      stableTimers: new Map(),
      readyTimers: new Map(),
      workerPorts: new Map(),
      launchTokens: new Map(),
      restartingWorkers: new Set(),
      stopping: false,
      nextWorkerId: instances,
    };
    this.apps.set(config.name, managed);

    // H2 fix: if proxy startup or any spawn throws, roll back the registration
    // so the app name isn't left wedged (and partial resources don't leak).
    try {
      this.reserveWorkerPorts(
        managed,
        Array.from({ length: instances }, (_, id) => id),
      );
      this.startProxyIfNeeded(config.name, managed.config, instances);
      for (let i = 0; i < instances; i++) {
        this.spawnWorker(managed, i);
      }
    } catch (err) {
      // The rollback is best-effort: its own failure must never mask the start
      // error the caller is waiting on.
      try {
        await this.rollbackApp(config.name, managed);
      } catch (rollbackError) {
        console.error(`[master] failed to roll back start for "${config.name}":`, rollbackError);
      }
      throw err;
    }
  }

  /** Tear down a partially-started app and remove it from the registry. */
  private async rollbackApp(name: string, managed: ManagedApp): Promise<void> {
    try {
      this.stopWorkerMonitors(managed);
      await this.workerHandler.stopAllWorkers(managed);
    } finally {
      // `killWorker` throws when a child survives SIGKILL. Registry, ports and
      // the proxy listener are global bookkeeping: they must be released even
      // then, or the app name stays wedged and the failed start is not
      // retryable for the life of the daemon (h68 applied the same rule to
      // stop/restart/delete).
      //
      // Unregister FIRST. Every statement below can throw (`stopProxy` calls
      // into the proxy, `closeApp` is injectable), and this is the one that
      // decides whether the operator can retry at all — it must not sit behind
      // anything that might not run.
      this.apps.delete(name);
      this.workerHandler.cleanupApp(managed);
      managed.spawned.clear();
      managed.launchTokens.clear();
      managed.startedAt = null;
      this.stopProxy(name);
      this.releaseAllWorkerPorts(managed);
      await this.logManager.closeApp?.(name);
    }
  }

  // -----------------------------------------------------------------------
  // Stop
  // -----------------------------------------------------------------------

  stopApp(name: string): Promise<void> {
    return this.withAppLock(name, () => this.stopAppUnlocked(name));
  }

  private async stopAppUnlocked(name: string): Promise<void> {
    const managed = this.getManaged(name);
    managed.stopping = true;
    try {
      this.stopWorkerMonitors(managed);
      await this.workerHandler.stopAllWorkers(managed);
      await this.logManager.closeApp?.(name);
    } finally {
      // Teardown must release every internal-port reservation, drop every
      // tracked pid, and mark the app stopped even if a kill failed part-way
      // (h68) — ports and the spawned map are the daemon's global bookkeeping
      // and must never leak on a failed stop.
      managed.startedAt = null;
      managed.spawned.clear();
      managed.launchTokens.clear();
      this.stopProxy(name);
      this.releaseAllWorkerPorts(managed);
      managed.stopping = false;
    }
  }

  // -----------------------------------------------------------------------
  // Restart (hard)
  // -----------------------------------------------------------------------

  restartApp(name: string, force = false): Promise<void> {
    return this.withAppLock(name, () => this.restartAppUnlocked(name, force));
  }

  private async restartAppUnlocked(name: string, force = false): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('Cannot restart an app while the daemon is shutting down.');
    }
    const managed = this.getManaged(name);
    managed.stopping = true;

    try {
      // Stop health checking and heartbeat monitoring before reset.
      this.stopWorkerMonitors(managed);
      await this.workerHandler.stopAllWorkers(managed, force);

      // Stop old proxy before respawning.
      this.stopProxy(name);
      this.releaseAllWorkerPorts(managed);
      await this.logManager.closeApp?.(name);

      // Clear stable timers and backoff timers from the old generation.
      this.workerHandler.cleanupApp(managed);
    } catch (error) {
      // Leave the app retryable even when teardown fails part-way through.
      managed.stopping = false;
      throw error;
    }

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
    managed.stopping = false;

    try {
      this.reserveWorkerPorts(
        managed,
        Array.from({ length: instances }, (_, id) => id),
      );
      this.startProxyIfNeeded(name, managed.config, instances);
      for (let i = 0; i < instances; i++) {
        this.spawnWorker(managed, i);
      }
    } catch (error) {
      managed.stopping = true;
      try {
        await this.rollbackRunningResources(name, managed);
      } catch (rollbackError) {
        console.error(`[master] failed to roll back restart for "${name}":`, rollbackError);
      } finally {
        managed.startedAt = null;
        managed.stopping = false;
      }
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Reload (zero-downtime)
  // -----------------------------------------------------------------------

  reloadApp(name: string): Promise<void> {
    return this.withAppLock(name, () => this.reloadAppUnlocked(name));
  }

  private async reloadAppUnlocked(name: string): Promise<void> {
    if (this.shuttingDown) {
      throw new Error('Cannot reload an app while the daemon is shutting down.');
    }
    const managed = this.getManaged(name);
    if (managed.startedAt === null || managed.stopping) {
      throw new Error(`App "${name}" is stopped; start or restart it before reloading.`);
    }
    const currentWorkers = [...managed.workers];
    const uncommittedReplacements = new Set<WorkerInfo>();
    const replacementByOldId = new Map<number, WorkerInfo>();

    try {
      await this.reloadHandler.rollingRestart({
        config: managed.config,
        workers: currentWorkers,
        processManager: this.processManager,
        lifecycle: this.lifecycle,
        spawnAndTrack: (_cfg, _wid) => {
          const newId = managed.nextWorkerId++;
          // The replacement inherits the drained worker's stable slot so the
          // exposed (app,worker) metric label set does not grow with reloads —
          // it identifies a position, not a process generation (h54). The
          // internal id stays monotonic; generation safety comes from per-launch
          // tokens, not ids.
          const inheritedSlot = currentWorkers.find((w) => w.id === _wid)?.slot ?? _wid;
          try {
            const worker = this.spawnWorker(managed, newId);
            worker.slot = inheritedSlot;
            uncommittedReplacements.add(worker);
            replacementByOldId.set(_wid, worker);
            return worker;
          } catch (error) {
            const partial = managed.workers.find((worker) => worker.id === newId);
            if (partial) {
              partial.slot = inheritedSlot;
              uncommittedReplacements.add(partial);
              replacementByOldId.set(_wid, partial);
            }
            throw error;
          }
        },
        drainAndStop: async (w) => {
          this.proxies.get(managed.config.name)?.removeWorker(w.id);
          try {
            await this.workerHandler.drainAndStopWorker(managed, w);
            // H1 fix: remove the drained worker from the managed list and tear
            // down its monitors/timers — otherwise every reload leaks a ghost.
            await this.retireWorker(managed, w);
            const replacement = replacementByOldId.get(w.id);
            if (replacement) uncommittedReplacements.delete(replacement);
          } catch (error) {
            // A failed kill means the old worker may still be serving. Restore
            // its state and proxy membership before rolling back its replacement.
            const oldSpawned = managed.spawned.get(w.id);
            if (oldSpawned && this.processManager.isRunning(oldSpawned.pid)) {
              w.state = 'online';
              this.proxies.get(managed.config.name)?.addWorker(w.id, managed.workerPorts.get(w.id));
            }
            throw error;
          }
        },
      });
    } catch (err) {
      // H3 fix: every replacement that has not been committed by a successful
      // old-worker drain must be retired, including online replacements. This
      // keeps a failed batch from leaving duplicate capacity or ghost workers.
      for (const r of uncommittedReplacements) {
        this.proxies.get(managed.config.name)?.removeWorker(r.id);
        try {
          await this.workerHandler.drainAndStopWorker(managed, r);
        } catch (cleanupError) {
          console.error(`[master] failed to clean up replacement worker ${r.id}:`, cleanupError);
        } finally {
          await this.retireWorker(managed, r);
        }
      }
      throw err;
    }
  }

  /** Remove a fully-drained worker and release all of its per-worker state. */
  private async retireWorker(managed: ManagedApp, worker: WorkerInfo): Promise<void> {
    this.healthChecker.stopChecking(worker.id, managed.config.name);
    this.healthChecker.stopHeartbeatMonitor(worker.id, managed.config.name);
    this.workerHandler.clearStableTimer(managed, worker.id);
    this.workerHandler.clearReadyTimer(managed, worker.id);
    this.workerHandler.clearBackoffTimer(worker.id, managed.config.name);
    this.crashRecovery.reset(worker.id, managed.config.name);
    this.releaseWorkerPort(managed, worker.id);
    await this.logManager.closeWorker?.(managed.config.name, worker.id);
    managed.launchTokens.delete(worker.id);
    managed.restartingWorkers.delete(worker.id);
    const idx = managed.workers.indexOf(worker);
    if (idx !== -1) managed.workers.splice(idx, 1);
  }

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  deleteApp(name: string): Promise<void> {
    return this.withAppLock(name, () => this.deleteAppUnlocked(name));
  }

  private async deleteAppUnlocked(name: string): Promise<void> {
    const managed = this.apps.get(name);
    if (!managed) return;
    managed.stopping = true;
    try {
      this.stopWorkerMonitors(managed);
      await this.workerHandler.stopAllWorkers(managed);
      await this.logManager.closeApp?.(name);
    } finally {
      // deleteApp must leave NO internal-port reservation, NO tracked pid, and
      // MUST unregister the app name even if a kill failed part-way (h68). Do all
      // of this in finally so a partial teardown can't strand ports, leave
      // spawned entries, or wedge the name.
      this.workerHandler.cleanupApp(managed);
      managed.spawned.clear();
      this.stopProxy(name);
      this.releaseAllWorkerPorts(managed);
      managed.startedAt = null;
      this.apps.delete(name);
      managed.stopping = false;
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
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    // Latch shutdown so no start/restart/reload can race the teardown (h46).
    this.shuttingDown = true;

    // Stop all health monitors first.
    this.healthChecker.stopAll();

    // Stop all proxies.
    for (const proxy of this.proxies.values()) {
      proxy.stop();
    }
    this.proxies.clear();

    const names = [...this.apps.keys()];
    const stopResults = await Promise.allSettled(names.map((n) => this.stopApp(n)));
    for (const [index, result] of stopResults.entries()) {
      if (result.status === 'rejected') {
        console.error(`[master] failed to stop "${names[index]}" during shutdown:`, result.reason);
      }
    }

    // Clean up managed resources
    await this.logManager.closeAll();

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
    const names = [...this.apps.entries()]
      .filter(([, managed]) => managed.startedAt !== null && !managed.stopping)
      .map(([name]) => name);
    for (const name of names) {
      await this.reloadApp(name);
    }
  }

  // -----------------------------------------------------------------------
  // Spawn
  // -----------------------------------------------------------------------

  private spawnWorker(managed: ManagedApp, workerId: number): WorkerInfo {
    this.reserveWorkerPorts(managed, [workerId]);
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
      // Serialize a restart's check-and-launch with reload/stop/delete on the
      // same app so a retire can't be raced (h16/h17). scheduleRestart only ever
      // fires from timers/callbacks (never inside a held lock), so this cannot
      // deadlock.
      runExclusive: (name, fn) => this.withAppLock(name, fn),
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
      this.healthChecker.stopChecking(worker.id, managed.config.name);
      this.healthChecker.stopHeartbeatMonitor(worker.id, managed.config.name);
    }
  }

  /** Start the TCP proxy for an app when its strategy requires one. */
  private startProxyIfNeeded(name: string, config: AppConfig, instances: number): void {
    if (!shouldUseProxy(config, instances)) return;
    if (config.port === undefined) return;
    const proxy = this.createProxyCluster();
    proxy.start(config.port, instances, this.apps.get(name)?.workerPorts);
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

  private assertPublicPortAvailable(config: AppConfig): void {
    if (config.port === undefined) return;
    if (this.allocatedInternalPorts.has(config.port)) {
      throw new Error(`Port ${config.port} is already reserved by a Bunpilot worker.`);
    }
    for (const managed of this.apps.values()) {
      if (managed.config.port === config.port) {
        throw new Error(`Port ${config.port} is already used by app "${managed.config.name}".`);
      }
    }
  }

  private reserveWorkerPorts(managed: ManagedApp, workerIds: number[]): void {
    if (!shouldUseProxy(managed.config, resolveInstances(managed.config.instances))) return;
    for (const workerId of workerIds) {
      if (managed.workerPorts.has(workerId)) continue;
      const port = this.allocateInternalPort();
      managed.workerPorts.set(workerId, port);
      this.allocatedInternalPorts.add(port);
    }
  }

  private allocateInternalPort(): number {
    const publicPorts = new Set(
      [...this.apps.values()]
        .map((managed) => managed.config.port)
        .filter((port): port is number => port !== undefined),
    );
    for (let port = INTERNAL_PORT_BASE; port <= 65_535; port++) {
      if (!this.allocatedInternalPorts.has(port) && !publicPorts.has(port)) return port;
    }
    throw new Error('No internal worker ports are available.');
  }

  private releaseWorkerPort(managed: ManagedApp, workerId: number): void {
    const port = managed.workerPorts.get(workerId);
    if (port !== undefined) this.allocatedInternalPorts.delete(port);
    managed.workerPorts.delete(workerId);
  }

  private releaseAllWorkerPorts(managed: ManagedApp): void {
    for (const port of managed.workerPorts.values()) this.allocatedInternalPorts.delete(port);
    managed.workerPorts.clear();
  }

  private async rollbackRunningResources(name: string, managed: ManagedApp): Promise<void> {
    this.stopWorkerMonitors(managed);
    await this.workerHandler.stopAllWorkers(managed);
    this.workerHandler.cleanupApp(managed);
    this.stopProxy(name);
    this.releaseAllWorkerPorts(managed);
    await this.logManager.closeApp?.(name);
    managed.workers = [];
    managed.spawned.clear();
  }

  /** Serialize lifecycle mutations per app while allowing different apps in parallel. */
  private async withAppLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueues.get(name) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    this.operationQueues.set(name, tail);

    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.operationQueues.get(name) === tail) this.operationQueues.delete(name);
    }
  }
}
