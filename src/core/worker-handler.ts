// ---------------------------------------------------------------------------
// bunpilot – Worker Exit / Restart / Stop Helpers
// ---------------------------------------------------------------------------

import type { AppConfig, WorkerInfo, WorkerMessage, WorkerState } from '../config/types';
import type { ProcessManager, SpawnedWorker } from './process-manager';
import type { CrashRecovery } from './backoff';
import type { WorkerLifecycle } from './lifecycle';

// ---------------------------------------------------------------------------
// Types shared with MasterOrchestrator
// ---------------------------------------------------------------------------

export interface ManagedApp {
  config: AppConfig;
  workers: WorkerInfo[];
  spawned: Map<number, SpawnedWorker>;
  startedAt: number | null;
  stableTimers: Map<number, ReturnType<typeof setTimeout>>;
  nextWorkerId: number;
}

// ---------------------------------------------------------------------------
// WorkerHandler
// ---------------------------------------------------------------------------

export class WorkerHandler {
  private readonly backoffTimers = new Map<number, ReturnType<typeof setTimeout>>();

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
        worker.memory = { ...msg.payload.memory, timestamp: Date.now() };
        worker.cpu = {
          user: msg.payload.cpu.user,
          system: msg.payload.cpu.system,
          percentage: 0,
          timestamp: Date.now(),
        };
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

    // Graceful stop completes normally.
    if (worker.state === 'stopping' || worker.state === 'draining') {
      this.transitionWorker(worker, 'stopped');
      return;
    }

    // Unexpected -> crashed.
    this.transitionWorker(worker, 'crashed');
    worker.lastCrashAt = Date.now();
    worker.consecutiveCrashes += 1;

    const decision = this.crashRecovery.onWorkerCrash(workerId, managed.config);

    if (decision === 'give-up') {
      this.transitionWorker(worker, 'errored');
      return;
    }

    // Bug 5 fix: Clear existing backoff timer before setting a new one.
    const existingTimer = this.backoffTimers.get(workerId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.backoffTimers.delete(workerId);
    }

    const delay = this.crashRecovery.getDelay(workerId);
    const timer = setTimeout(() => {
      this.backoffTimers.delete(workerId);
      if (worker.state === 'crashed') {
        onRestart(managed, worker);
      }
    }, delay);
    this.backoffTimers.set(workerId, timer);
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
  }

  // -----------------------------------------------------------------------
  // Stop all workers for an app
  // -----------------------------------------------------------------------

  async stopAllWorkers(managed: ManagedApp): Promise<void> {
    // Bug 5 fix: Clear all backoff timers to prevent stale restarts.
    for (const worker of managed.workers) {
      const timer = this.backoffTimers.get(worker.id);
      if (timer) {
        clearTimeout(timer);
        this.backoffTimers.delete(worker.id);
      }
    }

    const active = managed.workers.filter(
      (w) => w.state !== 'stopped' && w.state !== 'errored' && w.state !== 'crashed',
    );

    await Promise.all(
      active.map(async (worker) => {
        // Transition through draining/stopping if the state machine allows it
        if (this.lifecycle.canTransition(worker.state, 'draining')) {
          this.transitionWorker(worker, 'draining');
          this.transitionWorker(worker, 'stopping');
        }

        const spawned = managed.spawned.get(worker.id);
        if (spawned) {
          await this.processManager.killWorker(
            spawned.pid,
            managed.config.shutdownSignal,
            managed.config.killTimeout,
          );
        }

        // Force state to stopped regardless of current state (shutdown is authoritative)
        worker.state = 'stopped';
        this.clearStableTimer(managed, worker.id);
      }),
    );

    managed.spawned.clear();
  }

  // -----------------------------------------------------------------------
  // Stable timer
  // -----------------------------------------------------------------------

  scheduleStableCheck(managed: ManagedApp, worker: WorkerInfo): void {
    this.clearStableTimer(managed, worker.id);

    const timer = setTimeout(() => {
      if (worker.state === 'online') {
        this.crashRecovery.onWorkerStable(worker.id);
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

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  cleanupApp(managed: ManagedApp): void {
    for (const [wid] of managed.stableTimers) {
      this.clearStableTimer(managed, wid);
    }
    for (const w of managed.workers) {
      this.crashRecovery.reset(w.id);
      const timer = this.backoffTimers.get(w.id);
      if (timer) {
        clearTimeout(timer);
        this.backoffTimers.delete(w.id);
      }
    }
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
}
