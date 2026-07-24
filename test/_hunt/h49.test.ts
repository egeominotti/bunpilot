// h49 — HTTP health monitor is never torn down when the process it probes exits.
//
// AGENTS.md invariant: "A late message or exit from an old process generation
// must never mutate its replacement."
//
// The HTTP health monitor in src/health/checker.ts is keyed ONLY by
// (namespace, workerId) — there is no launch-generation token — so the monitor
// started for generation N keeps its interval, its captured URL and its
// failureCounts alive after generation N's process dies. handleWorkerExit
// (src/core/worker-launch.ts:160) clears the ready timer, removes the worker
// from the proxy and hands off to workerHandler.handleExit, but never calls
// healthChecker.stopChecking. startChecking is only re-invoked when the
// REPLACEMENT sends 'ready' (worker-launch.ts:145), so across the whole
// crash -> backoff -> kill -> PORT_RELEASE_DELAY -> spawn -> boot window the
// dead generation's probes keep hammering a port nobody is listening on and
// keep incrementing the SHARED failure counter. When it crosses the threshold
// the unhealthy callback fires against whatever worker currently occupies that
// id — i.e. the freshly spawned, perfectly healthy replacement.

import { expect, test } from 'bun:test';
import type { AppConfig } from '../../src/config/types';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Deterministic PRNG so the generated parameter matrix is reproducible.
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

interface Fixture {
  master: MasterOrchestrator;
  checker: {
    timers: Map<string, unknown>;
    failureCounts: Map<string, number>;
  };
  spawnCalls: number[];
  msgCbs: Map<number, (w: number, m: unknown) => void>;
  exitCbs: Map<number, (w: number, c: number | null, s: string | null) => void>;
  server: { stop: (force?: boolean) => void };
  workers: () => Array<{ id: number; state: string; restartCount: number }>;
  dispose: () => Promise<void>;
}

/**
 * Real MasterOrchestrator + real HealthChecker. Only ProcessManager and
 * LogManager are stubbed, so no child process is ever spawned; the "worker's"
 * HTTP health endpoint is a real Bun.serve on an ephemeral port that we can
 * kill at the exact instant the fake process exits.
 */
async function makeFixture(name: string, interval: number, threshold: number): Promise<Fixture> {
  const spawnCalls: number[] = [];
  const exitCbs = new Map<number, (w: number, c: number | null, s: string | null) => void>();
  const msgCbs = new Map<number, (w: number, m: unknown) => void>();

  const server = Bun.serve({ port: 0, fetch: () => new Response('ok') });

  const master = new MasterOrchestrator();
  // biome-ignore lint/suspicious/noExplicitAny: white-box access to private wiring
  const m = master as any;

  m.processManager = {
    spawnWorker(
      _cfg: AppConfig,
      wid: number,
      onMessage: (w: number, msg: unknown) => void,
      onExit: (w: number, c: number | null, s: string | null) => void,
    ): SpawnedWorker {
      spawnCalls.push(wid);
      msgCbs.set(wid, onMessage);
      exitCbs.set(wid, onExit);
      return {
        // biome-ignore lint/suspicious/noExplicitAny: stub subprocess
        proc: {} as any,
        pid: 90_000 + spawnCalls.length,
        stdout: new ReadableStream({ start: (c) => c.close() }),
        stderr: new ReadableStream({ start: (c) => c.close() }),
      };
    },
    async killWorker() {
      return 'exited' as const;
    },
    isRunning() {
      return false;
    },
  };
  m.logManager = {
    pipeOutput() {},
    async closeAll() {},
    async closeApp() {},
    async closeWorker() {},
  };

  const config: AppConfig = {
    name,
    script: 'app.ts',
    instances: 1,
    port: server.port,
    maxRestarts: 20,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 50,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 10, multiplier: 1, max: 10 },
    healthCheck: {
      enabled: true,
      path: '/health',
      interval,
      timeout: Math.max(50, Math.floor(interval / 2)),
      unhealthyThreshold: threshold,
    },
  };

  await master.startApp(config);

  return {
    master,
    checker: m.healthChecker,
    spawnCalls,
    msgCbs,
    exitCbs,
    server,
    workers: () =>
      // biome-ignore lint/suspicious/noExplicitAny: white-box read of managed state
      m.apps.get(name)?.workers.map((w: any) => ({
        id: w.id,
        state: w.state,
        restartCount: w.restartCount,
      })) ?? [],
    dispose: async () => {
      try {
        server.stop(true);
      } catch {}
      await master.shutdown('test');
    },
  };
}

// ---------------------------------------------------------------------------
// Property: for every (interval, threshold) the invariant must hold — once the
// process of a generation has exited, no HTTP monitor aimed at that generation
// may still be armed.
// ---------------------------------------------------------------------------

test('h49a: exiting a generation must tear down that generation HTTP health monitor', async () => {
  const seed = 0x1049;
  const rand = mulberry32(seed);

  // --- Part A (deterministic, no timing race): the monitor must be torn down
  // the moment the generation it probes exits. Several generated shapes.
  for (let i = 0; i < 4; i++) {
    const interval = 200 + Math.floor(rand() * 200); // 200..399
    const threshold = 2 + Math.floor(rand() * 3); // 2..4
    const name = `h49a${i}`;
    const key = `${name}\0${0}`;
    const f = await makeFixture(name, interval, threshold);
    try {
      f.msgCbs.get(0)?.(0, { type: 'ready' });
      await sleep(interval + 50); // at least one PASSING probe
      expect(f.checker.timers.has(key)).toBe(true);

      // The worker process dies: endpoint gone, onExit fires.
      f.server.stop(true);
      f.exitCbs.get(0)?.(0, 1, null);

      // INVARIANT: the exit of generation 1 must tear down generation 1's
      // HTTP monitor. Today it stays armed, still pointed at the dead port,
      // still owning the failure counter that the replacement will inherit.
      expect({
        seed,
        i,
        interval,
        threshold,
        armedAfterExit: f.checker.timers.has(key),
      }).toEqual({ seed, i, interval, threshold, armedAfterExit: false });
    } finally {
      await f.dispose();
    }
  }
}, 25_000);

// --- Part B: the observable consequence — a healthy booting replacement is
// killed and respawned by the dead generation's probes.
test('h49b: dead generation probes must not restart the healthy replacement', async () => {
  const name = 'h49b';
  const key = `${name}\0${0}`;
  const f = await makeFixture(name, 300, 3);
  try {
    f.msgCbs.get(0)?.(0, { type: 'ready' });
    await sleep(400); // passing probes against the live endpoint

    expect(f.spawnCalls.length).toBe(1);

    // Crash: the endpoint disappears together with the process.
    f.server.stop(true);
    f.exitCbs.get(0)?.(0, 1, null);

    // backoff(10ms) + PORT_RELEASE_DELAY(500ms) -> replacement spawns ~T+510
    // and sits in 'starting' while it boots. Give the stale monitor time to
    // reach its threshold (probes at T+~300/600/900 all ECONNREFUSED).
    await sleep(2_000);

    // One crash => exactly one restart => exactly 2 spawns of worker 0.
    expect({
      spawns: f.spawnCalls.length,
      restartCount: f.workers()[0]?.restartCount,
      staleMonitorArmed: f.checker.timers.has(key),
      failures: f.checker.failureCounts.get(key) ?? 0,
    }).toEqual({
      spawns: 2,
      restartCount: 1,
      staleMonitorArmed: false,
      failures: 0,
    });
  } finally {
    await f.dispose();
  }
}, 25_000);
