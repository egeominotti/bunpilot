// ---------------------------------------------------------------------------
// H16 – an aborted reload must not leave a live, untracked worker process
// ---------------------------------------------------------------------------
//
// Scenario (all real code paths, only process/log/health I/O is stubbed):
//
//   1. reloadApp() spawns a replacement worker that never sends `ready`.
//   2. Two independent deadlines fire off the same `readyTimeout`:
//        (a) scheduleReadyTimeout -> scheduleRestart -> restartWorker
//            (kills the old pid, then respawns)
//        (b) ReloadHandler.waitForReady times out ~one poll tick later, so
//            reloadAppUnlocked's catch drains + retires that same worker.
//   3. Both paths await ProcessManager.killWorker() on the SAME pid. Real
//      killWorker is a 100 ms poll loop, so the two waiters observe the exit on
//      two grids offset by the poll tick. When restartWorker's grid fires first
//      it resumes while the worker is still in managed.workers / launchTokens,
//      its stale() guard passes, and it launches a fresh child process.
//      Milliseconds later drainAndStopWorker completes and deletes
//      managed.spawned[id] + launchTokens[id] and retires the worker — dropping
//      every handle to the process that was just spawned.
//
// Invariant under test (AGENTS.md): a retired/stopped worker must be terminally
// dead, and stopApp must leave no live worker process behind. Here the daemon
// leaks a live, untracked child that stopApp/deleteApp/shutdown cannot see.
//
// The stub models killWorker exactly like src/core/process-manager.ts does:
// send the signal (schedule the graceful exit), then pollUntil(!isRunning).
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import type { CrashRecovery } from '../../src/core/backoff';
import type { WorkerLifecycle } from '../../src/core/lifecycle';
import { MasterOrchestrator } from '../../src/core/master';
import { pollUntil } from '../../src/core/poll';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

function makeConfig(name: string): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 150,
    backoff: { initial: 60_000, multiplier: 2, max: 60_000 },
    clustering: {
      enabled: false,
      strategy: 'proxy',
      rollingRestart: { batchSize: 1, batchDelay: 1_000 },
    },
  };
}

interface Harness {
  master: MasterOrchestrator;
  /** pids of child processes believed to be running. */
  alive: Set<number>;
  /** every pid ever spawned, in order. */
  spawns: number[];
  cleanup: () => void;
}

/**
 * @param gracefulExitMs how long a child takes to exit after SIGTERM.
 * @param autoReady      whether spawned children report `ready`.
 */
function makeHarness(gracefulExitMs: number): Harness {
  const master = new MasterOrchestrator();
  const m = master as unknown as Record<string, unknown> & { autoReady: boolean };
  const alive = new Set<number>();
  const spawns: number[] = [];
  const deathTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextPid = 90_000 + Math.floor(Math.random() * 1_000) * 100;

  m.autoReady = true;
  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (wid: number, msg: { type: 'ready' }) => void,
    ): SpawnedWorker {
      const pid = nextPid++;
      alive.add(pid);
      spawns.push(pid);
      const spawned: SpawnedWorker = {
        proc: {} as never,
        pid,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      };
      if (m.autoReady) queueMicrotask(() => onMessage(workerId, { type: 'ready' }));
      return spawned;
    },
    isRunning(pid: number): boolean {
      return alive.has(pid);
    },
    // Mirrors the real implementation: signal, then poll every 100 ms.
    async killWorker(pid: number, _signal: string, timeout: number): Promise<'exited' | 'killed'> {
      if (!alive.has(pid)) return 'exited';
      if (!deathTimers.has(pid)) {
        deathTimers.set(
          pid,
          setTimeout(() => alive.delete(pid), gracefulExitMs),
        );
      }
      const exited = await pollUntil(() => !alive.has(pid), timeout);
      if (exited) return 'exited';
      alive.delete(pid); // SIGKILL escalation
      return 'killed';
    },
  };

  m.logManager = { pipeOutput() {}, closeAll() {} };
  m.healthChecker = {
    onUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor() {},
    stopHeartbeatMonitor() {},
    onHeartbeat() {},
    stopAll() {},
  };
  m.createProxyCluster = () => ({ start() {}, addWorker() {}, removeWorker() {}, stop() {} });
  m.workerHandler = new WorkerHandler(
    m.processManager as never,
    m.crashRecovery as CrashRecovery,
    m.lifecycle as WorkerLifecycle,
  );

  return {
    master,
    alive,
    spawns,
    cleanup: () => {
      for (const t of deathTimers.values()) clearTimeout(t);
      deathTimers.clear();
      alive.clear();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) h.cleanup();
});

test('aborted reload must not leave a live untracked worker process', async () => {
  // Deterministic sweep over how long a child takes to die after SIGTERM.
  // Both killWorker waiters poll on 100 ms grids offset by one reload poll
  // tick, so the winner of the race depends on this delay modulo 100.
  const gracefulExits = [25, 75, 125, 175];
  const failures: string[] = [];

  for (const gracefulExitMs of gracefulExits) {
    const h = makeHarness(gracefulExitMs);
    harnesses.push(h);
    const master = h.master;
    const m = master as unknown as { autoReady: boolean; apps: Map<string, unknown> };
    const name = `h16-app-${gracefulExitMs}`;

    await master.startApp(makeConfig(name));
    const managed = m.apps.get(name) as { workers: Array<{ id: number }> };
    expect(managed.workers.length).toBe(1);
    expect(h.alive.size).toBe(1);

    // The replacement never becomes ready -> reload must abort and roll back.
    m.autoReady = false;
    await expect(master.reloadApp(name)).rejects.toThrow(/reload aborted/);

    // Let every in-flight timer/await settle.
    await sleep(600);

    // The daemon's own view of what is running.
    const tracked = new Set<number>(
      [...(managed as unknown as { spawned: Map<number, { pid: number }> }).spawned.values()].map(
        (s) => s.pid,
      ),
    );
    const untracked = [...h.alive].filter((pid) => !tracked.has(pid));

    // Now shut the app down: nothing of this app may still be running.
    await master.stopApp(name);
    await sleep(600);

    const leaked = [...h.alive];
    if (leaked.length > 0 || untracked.length > 0) {
      failures.push(
        `gracefulExitMs=${gracefulExitMs}: spawned pids=${JSON.stringify(h.spawns)} ` +
          `untracked-while-running=${JSON.stringify(untracked)} ` +
          `alive-after-stopApp=${JSON.stringify(leaked)}`,
      );
    }

    await master.deleteApp(name).catch(() => undefined);
  }

  expect(failures).toEqual([]);
}, 25_000);
