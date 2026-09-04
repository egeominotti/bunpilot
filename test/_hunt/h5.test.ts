// ---------------------------------------------------------------------------
// H5 — an in-flight restart must not resurrect a stopped/deleted app
// ---------------------------------------------------------------------------
//
// INV (AGENTS.md): "A stopped or deleting app must not be resurrected by
// health, heartbeat, readiness, or crash timers."
//
// scheduleRestart() checks `managed.stopping` exactly once, at entry
// (src/core/worker-launch.ts:119). restartWorker() then crosses two awaits —
// killWorker(), then sleep(PORT_RELEASE_DELAY)=500ms (worker-launch.ts:95) —
// and never re-checks. A stopApp()/deleteApp() that completes inside that
// window resolves, clears `stopping` in its finally, and is then undone by the
// resumed restart, which spawns a fresh live process for a dead app.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';

// --- seeded deterministic PRNG (mulberry32) --------------------------------
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  spawnCalls: Array<{ workerId: number; port: number | undefined }>;
  messageCallbacks: Map<number, (wid: number, msg: unknown) => void>;
  staleCallbacks: Map<number, (wid: number) => void>;
  isRunningResult: boolean;
  nextPid: number;
}

function makeCtx(): Ctx {
  return {
    spawnCalls: [],
    messageCallbacks: new Map(),
    staleCallbacks: new Map(),
    isRunningResult: false,
    nextPid: 7000,
  };
}

function emptyStream(): ReadableStream {
  return new ReadableStream({
    start(c) {
      c.close();
    },
  });
}

function stubMaster(master: MasterOrchestrator, ctx: Ctx): void {
  const m = master as any;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (wid: number, msg: unknown) => void,
      _onExit: (wid: number, code: number | null, sig: string | null) => void,
      port?: number,
    ): SpawnedWorker {
      ctx.spawnCalls.push({ workerId, port });
      ctx.messageCallbacks.set(workerId, onMessage);
      return {
        proc: {} as never,
        pid: ctx.nextPid++,
        stdout: emptyStream(),
        stderr: emptyStream(),
      };
    },
    async killWorker() {
      return 'exited' as const;
    },
    isRunning() {
      return ctx.isRunningResult;
    },
  };

  m.logManager = {
    pipeOutput() {},
    closeAll() {},
  };

  m.healthChecker = {
    onUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor(workerId: number, onStale: (wid: number) => void) {
      ctx.staleCallbacks.set(workerId, onStale);
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

  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {},
  });

  const { WorkerHandler } = require('../../src/core/worker-handler');
  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

function makeConfig(name: string, port: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 2,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    port,
    clustering: {
      enabled: true,
      strategy: 'proxy',
      rollingRestart: { batchSize: 1, batchDelay: 1_000 },
    },
  };
}

function clearAppTimers(managed: any): void {
  if (!managed) return;
  for (const t of managed.readyTimers.values()) clearTimeout(t);
  for (const t of managed.stableTimers.values()) clearTimeout(t);
  managed.readyTimers.clear();
  managed.stableTimers.clear();
}

test('stopApp/deleteApp are not undone by an in-flight restart', async () => {
  const SEEDS = [1, 2, 3, 4, 5, 6];

  for (const seed of SEEDS) {
    const rand = prng(seed);
    const op: 'stop' | 'delete' = rand() < 0.5 ? 'stop' : 'delete';
    const preOpDelay = [0, 40, 120][Math.floor(rand() * 3)] ?? 0;
    const isRunning = rand() < 0.5;

    const ctx = makeCtx();
    const master = new MasterOrchestrator();
    stubMaster(master, ctx);
    ctx.isRunningResult = isRunning;

    const name = `h5-app-${seed}`;
    const config = makeConfig(name, 3000 + seed);
    const m = master as any;
    let managed: unknown;

    try {
      await master.startApp(config);
      managed = m.apps.get(name);
      expect(ctx.spawnCalls.length).toBe(2); // workers 0 and 1

      // Worker 0 becomes ready (online).
      ctx.messageCallbacks.get(0)?.(0, { type: 'ready' });
      expect(master.getAppStatus(name)?.workers[0]?.state).toBe('online');

      // Its heartbeat goes stale -> the orchestrator schedules a restart, which
      // parks in `sleep(PORT_RELEASE_DELAY)` (500ms).
      const onStale = ctx.staleCallbacks.get(0);
      expect(typeof onStale).toBe('function');
      onStale?.(0);

      if (preOpDelay > 0) await sleep(preOpDelay);

      // The user stops (or deletes) the app. This resolves well inside the
      // 500ms port-release window.
      if (op === 'stop') {
        await master.stopApp(name);
      } else {
        await master.deleteApp(name);
      }

      const spawnsAtResolve = ctx.spawnCalls.length;

      if (op === 'stop') {
        expect(master.getAppStatus(name)?.status).toBe('stopped');
      } else {
        expect(master.getAppStatus(name)).toBeNull();
      }

      // Let the parked restart resume.
      await sleep(750);

      const detail =
        `seed=${seed} op=${op} preOpDelay=${preOpDelay} isRunning=${isRunning} ` +
        `spawns=${JSON.stringify(ctx.spawnCalls)}`;

      // INVARIANT: once stop/delete resolved, no new process may be created.
      expect(ctx.spawnCalls.length, `resurrected after ${op} resolved — ${detail}`).toBe(
        spawnsAtResolve,
      );

      if (op === 'stop') {
        expect(master.getAppStatus(name)?.status, `status flipped back — ${detail}`).toBe(
          'stopped',
        );
      } else {
        expect(master.getAppStatus(name), `app reappeared — ${detail}`).toBeNull();
      }
    } finally {
      clearAppTimers(managed);
      clearAppTimers(m.apps.get(name));
      try {
        await master.shutdown('SIGTERM');
      } catch {
        // ignore
      }
    }
  }
}, 20_000);
