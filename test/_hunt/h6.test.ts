// ---------------------------------------------------------------------------
// H6 — restartWorker never re-checks lifecycle state after its awaits.
//
// Invariant (AGENTS.md / WRK-12): once stopApp() / deleteApp() has RESOLVED for
// an app, no new worker process may be spawned for it by any background timer
// (heartbeat, ready-timeout, health, crash backoff).
//
// scheduleRestart() reads `managed.stopping` once, then restartWorker() awaits
// killWorker() and sleep(PORT_RELEASE_DELAY = 500ms) before calling
// launchWorker(). None of those callers take withAppLock, so a stop/delete that
// lands inside that window completes, and ~500ms later the in-flight restart
// spawns a brand-new process for an app the operator already stopped/deleted.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

// --- seeded deterministic PRNG (mulberry32) --------------------------------
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Ctx {
  spawnCalls: Array<{ workerId: number; pid: number }>;
  messageCallbacks: Map<number, (wid: number, msg: unknown) => void>;
  heartbeatStaleCallbacks: Map<number, (wid: number) => void>;
  nextPid: number;
}

function createCtx(): Ctx {
  return {
    spawnCalls: [],
    messageCallbacks: new Map(),
    heartbeatStaleCallbacks: new Map(),
    nextPid: 7000,
  };
}

function stubMaster(master: MasterOrchestrator, ctx: Ctx): void {
  // biome-ignore lint/suspicious/noExplicitAny: private-field stubbing, as the existing suite does
  const m = master as any;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (wid: number, msg: unknown) => void,
      _onExit: (wid: number, code: number | null, sig: string | null) => void,
    ): SpawnedWorker {
      const pid = ctx.nextPid++;
      ctx.spawnCalls.push({ workerId, pid });
      ctx.messageCallbacks.set(workerId, onMessage);
      return {
        // biome-ignore lint/suspicious/noExplicitAny: stub
        proc: {} as any,
        pid,
        stdout: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      };
    },
    async killWorker() {
      return 'exited' as const;
    },
    isRunning() {
      return true;
    },
  };

  m.logManager = {
    pipeOutput() {},
    closeAll() {},
  };

  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor(workerId: number, onStale: (wid: number) => void) {
      ctx.heartbeatStaleCallbacks.set(workerId, onStale);
    },
    stopHeartbeatMonitor() {},
    onHeartbeat() {},
    stopAll() {},
    getWorkerPort() {
      return undefined;
    },
    isHeartbeatStale() {
      return false;
    },
  };

  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

function makeConfig(name: string, port: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 1,
    port,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 1_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 60_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: internal ManagedApp shape
function clearAppTimers(managed: any): void {
  if (!managed) return;
  for (const t of managed.readyTimers.values()) clearTimeout(t);
  managed.readyTimers.clear();
  for (const t of managed.stableTimers.values()) clearTimeout(t);
  managed.stableTimers.clear();
}

test('no worker is spawned after stopApp/deleteApp resolves (in-flight restart)', async () => {
  const rng = makeRng(0xb00c);
  // biome-ignore lint/suspicious/noExplicitAny: cleanup bookkeeping
  const created: Array<{ master: MasterOrchestrator; managed: any }> = [];

  try {
    for (let i = 0; i < 6; i++) {
      const seed = Math.floor(rng() * 1e9);
      const op: 'stop' | 'delete' = seed % 2 === 0 ? 'stop' : 'delete';
      // land the stop somewhere inside restartWorker's 500ms port-release sleep
      const gapMs = 5 + (seed % 40);
      const name = `h6-app-${i}`;
      const port = 3000 + i;

      const ctx = createCtx();
      const master = new MasterOrchestrator();
      stubMaster(master, ctx);

      await master.startApp(makeConfig(name, port));
      // biome-ignore lint/suspicious/noExplicitAny: internal registry access
      const managed = (master as any).apps.get(name);
      created.push({ master, managed });

      expect(ctx.spawnCalls.length).toBe(1);

      // Bring worker 0 online.
      ctx.messageCallbacks.get(0)?.(0, { type: 'ready' });
      expect(managed.workers[0].state).toBe('online');

      // Heartbeat goes stale -> scheduleRestart -> restartWorker enters its
      // kill + 500ms port-release sleep.
      const onStale = ctx.heartbeatStaleCallbacks.get(0);
      expect(typeof onStale).toBe('function');
      onStale?.(0);

      await Bun.sleep(gapMs);

      // Operator stops (or deletes) the app while the restart is in flight.
      if (op === 'stop') {
        await master.stopApp(name);
      } else {
        await master.deleteApp(name);
      }

      const spawnsAtResolve = ctx.spawnCalls.length;
      // biome-ignore lint/suspicious/noExplicitAny: internal registry access
      const stillRegistered = (master as any).apps.has(name);
      if (op === 'delete') expect(stillRegistered).toBe(false);

      // Let the in-flight restart's 500ms sleep expire.
      await Bun.sleep(700);

      const detail = `seed=${seed} op=${op} gapMs=${gapMs} app=${name}`;
      // INVARIANT: nothing may spawn after the lifecycle op resolved.
      expect(
        `${detail} spawnsAfter=${ctx.spawnCalls.length}`,
        // biome-ignore lint/suspicious/noExplicitAny: message arg
      ).toBe(`${detail} spawnsAfter=${spawnsAtResolve}`);
      expect(`${detail} liveSpawned=${managed.spawned.size}`).toBe(`${detail} liveSpawned=0`);
      expect(`${detail} workerState=${managed.workers[0]?.state}`).toBe(
        `${detail} workerState=stopped`,
      );
    }
  } finally {
    for (const { master, managed } of created) {
      clearAppTimers(managed);
      try {
        await master.shutdown('SIGTERM');
      } catch {
        // ignore
      }
      clearAppTimers(managed);
    }
  }
}, 20_000);
