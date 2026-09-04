// ---------------------------------------------------------------------------
// H60 — Rolling reload with batchSize >= 2: a fail-fast Promise.all over the
// batch drains lets the rollback race the still-in-flight sibling drain.
//
// src/core/reload-handler.ts:64
//   await Promise.all(batch.map((w) => ctx.drainAndStop(w)));
//
// Promise.all rejects on the FIRST failing drain but does NOT cancel the
// siblings. master.reloadAppUnlocked's catch (master.ts:280-289) then iterates
// `uncommittedReplacements` while a sibling drain is still awaiting killWorker,
// so that sibling's replacement is retired. Moments later the sibling drain
// succeeds and retires the OLD worker too — both members of the pair die and
// nothing respawns them.
//
// Invariant (RL-2 / RL-4): a reload — successful OR failed — must never leave
// the app with fewer live workers than `instances`. A failed reload rolls back;
// it does not silently halve capacity.
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Seeded deterministic PRNG (mulberry32) — same seed => same schedule. */
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

function makeConfig(name: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 2,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 200,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    clustering: {
      enabled: true,
      strategy: 'proxy',
      // The batch that triggers it: BOTH old workers drain concurrently.
      rollingRestart: { batchSize: 2, batchDelay: 0 },
    },
    ...overrides,
  };
}

/** Replace only I/O-bound collaborators; keep the real ReloadHandler. */
function stub(master: MasterOrchestrator): void {
  const m = master as any;
  let nextPid = 7000;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (workerId: number, message: { type: 'ready' }) => void,
    ): SpawnedWorker {
      const spawned = {
        proc: {} as any,
        pid: nextPid++,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      };
      queueMicrotask(() => onMessage(workerId, { type: 'ready' }));
      return spawned;
    },
    async killWorker() {
      return 'exited' as const;
    },
    isRunning() {
      return false;
    },
  };

  m.logManager = { pipeOutput() {}, closeAll() {} };

  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking() {},
    stopChecking() {},
    startHeartbeatMonitor() {},
    stopHeartbeatMonitor() {},
    onHeartbeat() {},
    stopAll() {},
    getWorkerPort: () => 40001,
    isHeartbeatStale: () => false,
  };

  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {},
  });

  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);
}

const openMasters: MasterOrchestrator[] = [];

afterEach(async () => {
  while (openMasters.length > 0) {
    const master = openMasters.pop();
    if (!master) continue;
    const m = master as any;
    // Neutralise the synthetic kill failure so teardown can't reject.
    m.processManager.killWorker = async () => 'exited' as const;
    m.processManager.isRunning = () => false;
    for (const name of Array.from(m.apps.keys()) as string[]) {
      await master.deleteApp(name).catch(() => undefined);
    }
  }
});

/**
 * One trial: instances=2, batchSize=2. Worker 0's drain fails fast, worker 1's
 * drain succeeds after `slowDrainMs`. The reload must reject, and the app must
 * still own `instances` workers once every in-flight drain has settled.
 */
async function runTrial(seed: number, slowDrainMs: number): Promise<number> {
  const name = `h60-app-${seed}-${slowDrainMs}`;
  const master = new MasterOrchestrator();
  openMasters.push(master);
  stub(master);

  await master.startApp(makeConfig(name));

  const m = master as any;
  const managed = m.apps.get(name);
  await sleep(10);
  expect(managed.workers.length).toBe(2);
  for (const w of managed.workers) w.state = 'online';

  const pid0 = managed.spawned.get(0).pid;
  const pid1 = managed.spawned.get(1).pid;

  m.processManager.killWorker = async (pid: number) => {
    if (pid === pid0) throw new Error('synthetic drain failure');
    if (pid === pid1 && slowDrainMs > 0) await sleep(slowDrainMs);
    return 'exited' as const;
  };
  // Only the failed-kill worker is still alive, so master restores it to
  // 'online' and puts it back in the proxy.
  m.processManager.isRunning = (pid: number) => pid === pid0;

  await expect(master.reloadApp(name)).rejects.toThrow('synthetic drain failure');

  // Let the sibling drain (and its detached retireWorker) finish.
  await sleep(slowDrainMs + 150);

  return managed.workers.length;
}

test('H60: a failed batch drain must not halve capacity while a sibling drain is in flight', async () => {
  const rand = mulberry32(0x60c0ffee);
  // Deterministic schedule of sibling-drain latencies (ms).
  const delays = [0, 5, 20, 60, 120].map((base) => base + Math.floor(rand() * 3));

  const failures: Array<{ seed: number; slowDrainMs: number; workers: number }> = [];

  for (let seed = 0; seed < delays.length; seed++) {
    const slowDrainMs = delays[seed];
    const workers = await runTrial(seed, slowDrainMs);
    if (workers !== 2) failures.push({ seed, slowDrainMs, workers });
  }

  if (failures.length > 0) {
    console.error('H60 failing schedules:', JSON.stringify(failures));
  }

  expect({ failures, expectedWorkersPerTrial: 2 }).toEqual({
    failures: [],
    expectedWorkersPerTrial: 2,
  });
}, 20_000);
