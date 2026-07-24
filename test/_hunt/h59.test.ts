// ---------------------------------------------------------------------------
// h59 – reload's retireWorker races an in-flight restartWorker
// ---------------------------------------------------------------------------
//
// scheduleRestart(worker 0) parks inside restartWorker's PORT_RELEASE_DELAY
// sleep. While it sleeps, a reload drains + retires worker 0 (removing it from
// managed.workers, releasing its internal port, dropping its launch token).
// When the stranded restart resumes it unconditionally calls launchWorker on
// the retired WorkerInfo: a real process is spawned for an id that no longer
// exists in managed.workers, so nothing ever kills it (stopAllWorkers only
// iterates managed.workers before clearing managed.spawned), and its port falls
// back to resolveWorkerPort() = INTERNAL_PORT_BASE + id — a port the allocator
// has already handed back to the pool.
//
// Invariant asserted after each seeded interleaving:
//   (a) every key in managed.spawned / managed.launchTokens belongs to a worker
//       still present in managed.workers;
//   (b) every pid the process manager ever spawned is either live-and-tracked
//       or was passed to killWorker.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { WorkerHandler } from '../../src/core/worker-handler';

// Deterministic PRNG (mulberry32) so failures are reproducible from the seed.
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

interface SpawnRecord {
  pid: number;
  workerId: number;
  port: number | undefined;
}

interface Harness {
  master: MasterOrchestrator;
  spawns: SpawnRecord[];
  killed: Set<number>;
  staleCallbacks: Map<number, (wid: number) => void>;
}

function makeConfig(name: string, port: number): AppConfig {
  return {
    name,
    script: 'app.ts',
    instances: 2,
    maxRestarts: 5,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 1_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 5_000,
    port,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    clustering: {
      enabled: true,
      strategy: 'proxy',
      rollingRestart: { batchSize: 2, batchDelay: 0 },
    },
  };
}

function harness(oldProcessStillRunning: boolean): Harness {
  const master = new MasterOrchestrator();
  const m = master as any;

  const spawns: SpawnRecord[] = [];
  const killed = new Set<number>();
  const staleCallbacks = new Map<number, (wid: number) => void>();
  let nextPid = 9000;

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (workerId: number, message: { type: 'ready' }) => void,
      _onExit: unknown,
      portOverride?: number,
    ): SpawnedWorker {
      const pid = nextPid++;
      spawns.push({ pid, workerId, port: portOverride });
      queueMicrotask(() => onMessage(workerId, { type: 'ready' }));
      return {
        proc: {} as any,
        pid,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      };
    },
    async killWorker(pid: number) {
      killed.add(pid);
      return 'exited' as const;
    },
    isRunning() {
      return oldProcessStillRunning;
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
    startHeartbeatMonitor(workerId: number, onStale: (wid: number) => void) {
      staleCallbacks.set(workerId, onStale);
    },
    stopHeartbeatMonitor() {},
    onHeartbeat() {},
    stopAll() {},
    getWorkerPort: () => undefined,
    isHeartbeatStale: () => false,
  };

  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {},
  });

  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);

  return { master, spawns, killed, staleCallbacks };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('reload never strands an in-flight restart: no untracked spawned process survives', async () => {
  const violations: string[] = [];

  for (let seed = 1; seed <= 6; seed++) {
    const rand = prng(seed);
    const gapMs = Math.floor(rand() * 30); // stale -> reload interleaving
    const oldRunning = rand() < 0.5; // exercise both restart kill paths
    const name = `h59-app-${seed}`;
    const port = 31_500 + seed;

    const { master, spawns, killed, staleCallbacks } = harness(oldRunning);
    const m = master as any;

    try {
      await master.startApp(makeConfig(name, port));
      await sleep(10);

      const managed = m.apps.get(name);
      expect(managed.workers.length).toBe(2);
      expect(managed.workers.every((w: any) => w.state === 'online')).toBe(true);

      // Worker 0's heartbeat goes stale -> scheduleRestart parks in the
      // PORT_RELEASE_DELAY sleep inside restartWorker.
      const onStale = staleCallbacks.get(0);
      expect(typeof onStale).toBe('function');
      onStale?.(0);

      await sleep(gapMs);

      // A reload lands mid-flight: replacements 2/3 come up, 0/1 are retired.
      await master.reloadApp(name);

      // Let the stranded restart wake up (PORT_RELEASE_DELAY = 500ms).
      await sleep(650);

      const liveIds = new Set<number>(managed.workers.map((w: any) => w.id));

      for (const id of managed.spawned.keys() as IterableIterator<number>) {
        if (!liveIds.has(id)) {
          violations.push(
            `seed=${seed} gapMs=${gapMs} oldRunning=${oldRunning}: managed.spawned has id ${id} ` +
              `(pid ${managed.spawned.get(id).pid}) which is not in managed.workers [${[...liveIds]}]`,
          );
        }
      }
      for (const id of managed.launchTokens.keys() as IterableIterator<number>) {
        if (!liveIds.has(id)) {
          violations.push(
            `seed=${seed} gapMs=${gapMs} oldRunning=${oldRunning}: managed.launchTokens has ` +
              `id ${id} which is not in managed.workers [${[...liveIds]}]`,
          );
        }
      }

      // "Tracked" means: reachable from a worker that is still in
      // managed.workers — that is the only set stopAllWorkers ever kills.
      const trackedPids = new Set<number>();
      for (const id of liveIds) {
        const s: SpawnedWorker | undefined = managed.spawned.get(id);
        if (s) trackedPids.add(s.pid);
      }
      for (const rec of spawns) {
        if (!killed.has(rec.pid) && !trackedPids.has(rec.pid)) {
          violations.push(
            `seed=${seed} gapMs=${gapMs} oldRunning=${oldRunning}: orphan process pid ${rec.pid} ` +
              `(workerId ${rec.workerId}, port ${rec.port}) was spawned, never killed, and is not ` +
              `reachable from any live worker`,
          );
        }
      }

      // A full stop must signal every process bunpilot ever started.
      await master.stopApp(name);
      for (const rec of spawns) {
        if (!killed.has(rec.pid)) {
          violations.push(
            `seed=${seed} gapMs=${gapMs} oldRunning=${oldRunning}: pid ${rec.pid} ` +
              `(workerId ${rec.workerId}, port ${rec.port}) survived stopApp() unsignalled`,
          );
        }
      }
    } finally {
      await master.shutdown('SIGTERM').catch(() => undefined);
    }

    if (violations.length > 0) break;
  }

  expect(violations).toEqual([]);
}, 25_000);
