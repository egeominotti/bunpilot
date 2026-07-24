// ---------------------------------------------------------------------------
// h68 – one killWorker rejection in stopAllWorkers aborts the whole batch
// ---------------------------------------------------------------------------
//
// Invariant (AGENTS.md / WRK-17): teardown must attempt cleanup for every app
// and every registered resource even if one cleanup fails. Concretely:
// after stopApp()/deleteApp() has settled (resolved OR rejected), the master
// must hold no internal-port reservation for that app, and deleteApp must not
// leave the app name registered.
//
// Pure in-memory test: every collaborator of MasterOrchestrator is stubbed, no
// real process is spawned, no socket is opened, no file is touched.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { type ManagedApp, WorkerHandler } from '../../src/core/worker-handler';

// --- seeded PRNG (mulberry32) ---------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- stubs -----------------------------------------------------------------

interface Ctx {
  nextPid: number;
  /** pids for which killWorker must reject (simulates surviving SIGKILL) */
  failingPids: Set<number>;
  killCalls: number[];
  spawnedPidsByWorker: Map<number, number>;
}

function makeCtx(): Ctx {
  return { nextPid: 7000, failingPids: new Set(), killCalls: [], spawnedPidsByWorker: new Map() };
}

const emptyStream = () =>
  new ReadableStream({
    start(c) {
      c.close();
    },
  });

function stubMaster(master: MasterOrchestrator, ctx: Ctx): void {
  const m = master as unknown as Record<string, unknown>;

  m.processManager = {
    spawnWorker(_config: AppConfig, workerId: number): SpawnedWorker {
      const pid = ctx.nextPid++;
      ctx.spawnedPidsByWorker.set(workerId, pid);
      return { proc: {} as never, pid, stdout: emptyStream(), stderr: emptyStream() };
    },
    async killWorker(pid: number) {
      ctx.killCalls.push(pid);
      if (ctx.failingPids.has(pid)) {
        throw new Error(`Process ${pid} is still running after SIGKILL`);
      }
      return 'exited' as const;
    },
    isRunning() {
      return false;
    },
  };

  m.logManager = {
    pipeOutput() {},
    closeAll() {},
    closeApp() {},
    closeWorker() {},
  };

  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor() {},
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

  // WorkerHandler captured the real ProcessManager in the constructor; rebuild
  // it against the stub (same technique as test/core/master.test.ts).
  m.workerHandler = new WorkerHandler(
    m.processManager as never,
    m.crashRecovery as never,
    m.lifecycle as never,
  );
}

function makeProxyConfig(name: string, instances: number, port: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances,
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

// Any timer left behind by an aborted teardown must not keep the runner alive.
const trackedApps: ManagedApp[] = [];

afterAll(() => {
  for (const managed of trackedApps) {
    for (const t of managed.readyTimers.values()) clearTimeout(t);
    for (const t of managed.stableTimers.values()) clearTimeout(t);
    managed.readyTimers.clear();
    managed.stableTimers.clear();
  }
});

// ---------------------------------------------------------------------------

test('teardown releases internal ports and unregisters the app even when one kill fails', async () => {
  const BASE_SEED = 20260723;
  const ITERATIONS = 24;

  for (let i = 0; i < ITERATIONS; i++) {
    const seed = BASE_SEED + i;
    const rnd = mulberry32(seed);

    const master = new MasterOrchestrator();
    const ctx = makeCtx();
    stubMaster(master, ctx);

    const instances = 2 + Math.floor(rnd() * 3); // 2..4 -> proxy strategy engages
    const publicPort = 30_000 + Math.floor(rnd() * 1_000);
    const name = `h68-app-${seed}`;
    const op: 'stop' | 'delete' = rnd() < 0.5 ? 'stop' : 'delete';

    await master.startApp(makeProxyConfig(name, instances, publicPort));

    const priv = master as unknown as {
      allocatedInternalPorts: Set<number>;
      apps: Map<string, ManagedApp>;
    };
    const allocated = priv.allocatedInternalPorts;
    const managed = priv.apps.get(name)!;
    trackedApps.push(managed);

    // Sanity: the proxy strategy really did reserve one internal port per worker.
    expect(allocated.size).toBe(instances);
    expect(managed.spawned.size).toBe(instances);

    // Pick one worker whose SIGKILL escalation "fails".
    const victimWorkerId = Math.floor(rnd() * instances);
    const victimPid = ctx.spawnedPidsByWorker.get(victimWorkerId)!;
    ctx.failingPids.add(victimPid);

    // The operation may resolve or reject — the invariant is about the state it
    // leaves behind, not about the return channel.
    let rejected = false;
    const run = op === 'delete' ? master.deleteApp(name) : master.stopApp(name);
    await run.catch(() => {
      rejected = true;
    });

    const detail =
      `seed=${seed} op=${op} instances=${instances} victimWorker=${victimWorkerId} ` +
      `victimPid=${victimPid} rejected=${rejected} leakedPorts=[${[...allocated].join(',')}]`;

    // INVARIANT 1: no internal port stays reserved for a stopped/deleted app.
    expect(`${detail} :: allocatedInternalPorts=${allocated.size}`).toBe(
      `${detail} :: allocatedInternalPorts=0`,
    );

    // INVARIANT 2: deleteApp must not leave the app name wedged in the registry.
    if (op === 'delete') {
      expect(`${detail} :: registered=${priv.apps.has(name)}`).toBe(
        `${detail} :: registered=false`,
      );
    }

    // INVARIANT 3: per-app spawn bookkeeping is cleared by the teardown batch.
    expect(`${detail} :: spawned=${managed.spawned.size}`).toBe(`${detail} :: spawned=0`);
  }
});
