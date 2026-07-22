// ---------------------------------------------------------------------------
// bunpilot – Worker Exit / Restart / Stop Helpers
// ---------------------------------------------------------------------------

import type { AppConfig, WorkerInfo, WorkerMessage, WorkerState } from '../config/types';
import type { CrashRecovery } from './backoff';
import type { WorkerLifecycle } from './lifecycle';
import type { ProcessManager, SpawnedWorker } from './process-manager';

// ---------------------------------------------------------------------------
// Types shared with MasterOrchestrator
// ---------------------------------------------------------------------------

export interface ManagedApp {
  config: AppConfig;
  workers: WorkerInfo[];
  spawned: Map<number, SpawnedWorker>;
  startedAt: number | null;
  stableTimers: Map<number, ReturnType<typeof setTimeout>>;
  readyTimers: Map<number, ReturnType<typeof setTimeout>>;
  workerPorts: Map<number, number>;
  launchTokens: Map<number, symbol>;
  restartingWorkers: Set<number>;
  stopping: boolean;
  nextWorkerId: number;
}

// ---------------------------------------------------------------------------
// WorkerHandler
// ---------------------------------------------------------------------------

export class WorkerHandler {
  private readonly backoffTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly processManager: ProcessManager,
    private readonly crashRecovery: CrashRecovery,
    private readonly lifecycle: WorkerLifecycle,
  ) {}

  // -----------------------------------------------------------------------
  // IPC message handling
  // -----------------------------------------------------------------------

  handleMessage(managed: ManagedApp, workerId: number, msg: WorkerMessage): void {
    const worker = this.findWorker(managed, workerId);
    if (!worker) return;

    switch (msg.type) {
      case 'ready':
        this.transitionWorker(worker, 'online');
        worker.readyAt = Date.now();
        break;

      case 'metrics':
        {
          const timestamp = Date.now();
          const previous = worker.cpu;
          const cpuTotal = msg.payload.cpu.user + msg.payload.cpu.system;
          const previousTotal = previous ? previous.user + previous.system : cpuTotal;
          const elapsedMicros = previous ? (timestamp - previous.timestamp) * 1_000 : 0;
          const deltaMicros = cpuTotal - previousTotal;
          const percentage =
            elapsedMicros > 0 && deltaMicros >= 0 ? (deltaMicros / elapsedMicros) * 100 : 0;

          worker.memory = { ...msg.payload.memory, timestamp };
          worker.cpu = {
            user: msg.payload.cpu.user,
            system: msg.payload.cpu.system,
            percentage,
            timestamp,
          };
        }
        break;

      case 'heartbeat':
      case 'custom':
        break;
    }
  }

  // -----------------------------------------------------------------------
  // Exit handling
  // -----------------------------------------------------------------------

  handleExit(
    managed: ManagedApp,
    workerId: number,
    exitCode: number | null,
    signalCode: string | null,
    onRestart: (managed: ManagedApp, worker: WorkerInfo) => void,
  ): void {
    const worker = this.findWorker(managed, workerId);
    if (!worker) return;

    worker.exitCode = exitCode;
    worker.signalCode = signalCode;
    this.clearStableTimer(managed, workerId);
    this.clearReadyTimer(managed, workerId);

    // Graceful stop completes normally. M3 fix: a 'draining' worker must step
    // through 'stopping' first (draining -> stopped is not a valid transition),
    // otherwise it would get stuck in 'draining' on exit.
    if (worker.state === 'stopping' || worker.state === 'draining') {
      if (worker.state === 'draining') {
        this.transitionWorker(worker, 'stopping');
      }
      if (!this.transitionWorker(worker, 'stopped')) {
        worker.state = 'stopped';
      }
      return;
    }

    // Unexpected -> crashed.
    this.transitionWorker(worker, 'crashed');
    worker.lastCrashAt = Date.now();
    worker.consecutiveCrashes += 1;

    const decision = this.crashRecovery.onWorkerCrash(
      workerId,
      managed.config,
      managed.config.name,
    );

    if (decision === 'give-up') {
      this.transitionWorker(worker, 'errored');
      return;
    }

    // Bug 5 fix: Clear existing backoff timer before setting a new one.
    const timerKey = this.workerKey(managed, workerId);
    const existingTimer = this.backoffTimers.get(timerKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.backoffTimers.delete(timerKey);
    }

    const delay = this.crashRecovery.getDelay(workerId, managed.config.name);
    const timer = setTimeout(() => {
      this.backoffTimers.delete(timerKey);
      if (worker.state === 'crashed') {
        onRestart(managed, worker);
      }
    }, delay);
    this.backoffTimers.set(timerKey, timer);
  }

  // -----------------------------------------------------------------------
  // Drain + stop a single worker
  // -----------------------------------------------------------------------

  async drainAndStopWorker(managed: ManagedApp, worker: WorkerInfo): Promise<void> {
    // Already stopped — nothing to do.
    if (worker.state === 'stopped' || worker.state === 'errored') return;

    // For online workers, go through the proper drain path.
    if (worker.state === 'online') {
      this.transitionWorker(worker, 'draining');
      this.transitionWorker(worker, 'stopping');
    }

    // Bug 8 fix: For non-online workers (starting, spawning, etc.),
    // still kill the process and force the state to stopped.
    const spawned = managed.spawned.get(worker.id);
    if (spawned) {
      await this.processManager.killWorker(
        spawned.pid,
        managed.config.shutdownSignal,
        managed.config.killTimeout,
      );
    }

    // Use state machine if possible, otherwise force stopped.
    if (!this.transitionWorker(worker, 'stopped')) {
      worker.state = 'stopped';
    }
    managed.spawned.delete(worker.id);
    managed.launchTokens.delete(worker.id);
    this.clearReadyTimer(managed, worker.id);
  }

  // -----------------------------------------------------------------------
  // Stop all workers for an app
  // -----------------------------------------------------------------------

  async stopAllWorkers(managed: ManagedApp, force = false): Promise<void> {
    // Bug 5 fix: Clear all backoff timers to prevent stale restarts.
    for (const worker of managed.workers) {
      const timerKey = this.workerKey(managed, worker.id);
      const timer = this.backoffTimers.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        this.backoffTimers.delete(timerKey);
      }
    }

    const active = managed.workers.filter(
      (w) => w.state !== 'stopped' && w.state !== 'errored' && w.state !== 'crashed',
    );

    await Promise.all(
      active.map(async (worker) => {
        // Transition through draining/stopping if the state machine allows it.
        if (this.lifecycle.canTransition(worker.state, 'draining')) {
          this.transitionWorker(worker, 'draining');
          this.transitionWorker(worker, 'stopping');
        } else {
          // H4 fix: 'starting'/'spawning' workers can't reach 'draining'. Force
          // them to 'stopping' BEFORE the kill so that if the process exits
          // mid-kill, handleExit classifies it as a graceful stop rather than a
          // crash (which would pollute crash counters and set a stale backoff
          // timer). Shutdown is authoritative.
          worker.state = 'stopping';
        }

        const spawned = managed.spawned.get(worker.id);
        if (spawned) {
          await this.processManager.killWorker(
            spawned.pid,
            managed.config.shutdownSignal,
            force ? 0 : managed.config.killTimeout,
          );
        }

        // Force state to stopped regardless of current state (shutdown is authoritative)
        worker.state = 'stopped';
        this.clearStableTimer(managed, worker.id);
        // Belt-and-suspenders: drop any backoff timer a mid-kill exit may have set.
        this.clearBackoffTimer(worker.id, managed.config.name);
        this.clearReadyTimer(managed, worker.id);
      }),
    );

    managed.spawned.clear();
    managed.launchTokens.clear();
  }

  // -----------------------------------------------------------------------
  // Stable timer
  // -----------------------------------------------------------------------

  scheduleStableCheck(managed: ManagedApp, worker: WorkerInfo): void {
    this.clearStableTimer(managed, worker.id);

    const timer = setTimeout(() => {
      if (worker.state === 'online') {
        this.crashRecovery.onWorkerStable(worker.id, managed.config.name);
        worker.consecutiveCrashes = 0;
      }
    }, managed.config.minUptime);

    managed.stableTimers.set(worker.id, timer);
  }

  clearStableTimer(managed: ManagedApp, workerId: number): void {
    const timer = managed.stableTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      managed.stableTimers.delete(workerId);
    }
  }

  scheduleReadyTimeout(
    managed: ManagedApp,
    worker: WorkerInfo,
    onTimeout: (worker: WorkerInfo) => void,
  ): void {
    this.clearReadyTimer(managed, worker.id);
    const token = managed.launchTokens.get(worker.id);
    const timer = setTimeout(() => {
      managed.readyTimers.delete(worker.id);
      if (
        managed.launchTokens.get(worker.id) === token &&
        worker.state === 'starting' &&
        !managed.stopping
      ) {
        onTimeout(worker);
      }
    }, managed.config.readyTimeout);
    managed.readyTimers.set(worker.id, timer);
  }

  clearReadyTimer(managed: ManagedApp, workerId: number): void {
    const timer = managed.readyTimers.get(workerId);
    if (timer) {
      clearTimeout(timer);
      managed.readyTimers.delete(workerId);
    }
  }

  /** Clear a pending crash-backoff timer for a single worker, if any. */
  clearBackoffTimer(workerId: number, namespace: string = ''): void {
    const timerKey = this.workerKeyFromNamespace(namespace, workerId);
    const timer = this.backoffTimers.get(timerKey);
    if (timer) {
      clearTimeout(timer);
      this.backoffTimers.delete(timerKey);
    }
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  cleanupApp(managed: ManagedApp): void {
    for (const [wid] of managed.stableTimers) {
      this.clearStableTimer(managed, wid);
    }
    for (const [wid] of managed.readyTimers) {
      this.clearReadyTimer(managed, wid);
    }
    for (const w of managed.workers) {
      this.crashRecovery.reset(w.id, managed.config.name);
      // Preserve compatibility for callers that populated an unscoped
      // CrashRecovery directly before handing it to this handler.
      this.crashRecovery.reset(w.id);
      const timerKey = this.workerKey(managed, w.id);
      const timer = this.backoffTimers.get(timerKey);
      if (timer) {
        clearTimeout(timer);
        this.backoffTimers.delete(timerKey);
      }
    }
    managed.launchTokens.clear();
    managed.restartingWorkers.clear();
  }

  // -----------------------------------------------------------------------
  // Shared utility
  // -----------------------------------------------------------------------

  transitionWorker(worker: WorkerInfo, to: WorkerState): boolean {
    const from = worker.state;
    if (this.lifecycle.canTransition(from, to)) {
      this.lifecycle.transition(worker.id, from, to);
      worker.state = to;
      return true;
    }
    return false;
  }

  findWorker(managed: ManagedApp, workerId: number): WorkerInfo | undefined {
    return managed.workers.find((w) => w.id === workerId);
  }

  private workerKey(managed: ManagedApp, workerId: number): string {
    return this.workerKeyFromNamespace(managed.config.name, workerId);
  }

  private workerKeyFromNamespace(namespace: string, workerId: number): string {
    return `${namespace}\0${workerId}`;
  }
}
