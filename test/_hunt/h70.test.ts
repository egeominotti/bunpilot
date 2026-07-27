// ---------------------------------------------------------------------------
// h70 – stale restart generation / failed relaunch / start rollback
// ---------------------------------------------------------------------------
//
// Four core-lifecycle invariants, all driven through a real MasterOrchestrator
// with every collaborator stubbed (no real process, socket or file):
//
// 1. `restartWorker`'s resurrection guard must only drop the spawned handle IT
//    owns. `restartApp` reuses worker ids (it clears `workers`/`spawned` and
//    respawns 0..n-1 on the same ManagedApp), so a crash-restart parked in the
//    PORT_RELEASE_DELAY sleep resumes into a NEWER generation. An unconditional
//    `managed.spawned.delete(worker.id)` there orphans the replacement:
//    `stopAllWorkers` only kills what is in `spawned`, so the live process
//    survives every stop/delete/shutdown and wedges its port.
//    INVARIANT: after everything settles `managed.spawned` still holds the
//    replacement handle, and `stopApp` signals the replacement pid.
//
// 2. `processManager.spawnWorker` is a bare `Bun.spawn`: it throws synchronously
//    on ENOENT / EAGAIN / EMFILE. If that throw escapes `restartWorker` the
//    worker is stranded in 'starting' with no process, no timers and no retry
//    path while `getAppStatus` still reports 'running'.
//    INVARIANT: a failed relaunch transitions starting -> crashed and the
//    backoff timer brings the worker back to 'online'.
//
// 3. `rollbackApp` must release global bookkeeping (registry entry, proxy
//    listener, internal ports) even when `killWorker` throws because a child
//    survived SIGKILL, and must never mask the original start failure.
//    INVARIANT: the surfaced error is the original spawn error, the app name is
//    free again (the start is retryable), the proxy was stopped and no internal
//    port stays reserved.
//
// 4. `launchWorker` is not atomic: the log wiring that runs AFTER `Bun.spawn`
//    does synchronous fs work and throws with the child already live. Handling
//    that throw by dropping the spawned handle would orphan a running process.
//    INVARIANT: the partially-launched child is killed, its launch token is
//    dropped (so its exit cannot double-count the crash), and backoff still
//    brings the worker back to 'online'.
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import type { AppConfig, WorkerState } from '../../src/config/types';
import { INTERNAL_PORT_BASE } from '../../src/constants';
import { MasterOrchestrator } from '../../src/core/master';
import type { SpawnedWorker } from '../../src/core/process-manager';
import { type ManagedApp, WorkerHandler } from '../../src/core/worker-handler';
import type { LaunchDeps } from '../../src/core/worker-launch';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface SpawnRecord {
  pid: number;
  workerId: number;
  attempt: number;
  port: number | undefined;
}

interface Ctx {
  nextPid: number;
  spawns: SpawnRecord[];
  /** total spawnWorker calls per worker id, including the ones that threw */
  spawnAttempts: Map<number, number>;
  killed: number[];
  proxyStops: number;
  /** every lifecycle transition, as `"<workerId>:<from>-><to>"` */
  transitions: string[];
  /** latest per-worker onExit callback handed to spawnWorker */
  exitCallbacks: Map<number, (wid: number, code: number | null, sig: string | null) => void>;
  /** completed `restartWorker` critical sections (its runExclusive block) */
  exclusiveRuns: number;
  /** health/heartbeat monitor calls, as `"<event>:<workerId>"` */
  monitorEvents: string[];
  // --- knobs ---
  autoReady: boolean;
  isRunning: boolean;
  failSpawn: ((workerId: number, attempt: number) => boolean) | null;
  /** make the post-spawn log wiring throw (LogWriter does sync fs work) */
  failPipe: ((workerId: number, attempt: number) => boolean) | null;
  failKills: boolean;
}

interface Harness {
  master: MasterOrchestrator;
  ctx: Ctx;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const emptyStream = () =>
  new ReadableStream({
    start(c) {
      c.close();
    },
  });

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`h70: timed out waiting for ${label}`);
    await sleep(5);
  }
}

/** Masters + their managed apps, torn down after every test. */
const live: Harness[] = [];
const trackedApps: ManagedApp[] = [];

function harness(): Harness {
  const master = new MasterOrchestrator();
  const m = master as any;

  const ctx: Ctx = {
    nextPid: 8000,
    spawns: [],
    spawnAttempts: new Map(),
    killed: [],
    proxyStops: 0,
    transitions: [],
    exitCallbacks: new Map(),
    exclusiveRuns: 0,
    monitorEvents: [],
    autoReady: true,
    isRunning: false,
    failSpawn: null,
    failPipe: null,
    failKills: false,
  };

  m.processManager = {
    spawnWorker(
      _config: AppConfig,
      workerId: number,
      onMessage: (workerId: number, message: { type: 'ready' }) => void,
      onExit: (wid: number, code: number | null, sig: string | null) => void,
      portOverride?: number,
    ): SpawnedWorker {
      const attempt = (ctx.spawnAttempts.get(workerId) ?? 0) + 1;
      ctx.spawnAttempts.set(workerId, attempt);
      // Bun.spawn throws synchronously (ENOENT / EAGAIN / EMFILE).
      if (ctx.failSpawn?.(workerId, attempt)) {
        throw new Error(`h70 spawn failure: worker ${workerId} attempt ${attempt}`);
      }
      const pid = ctx.nextPid++;
      ctx.spawns.push({ pid, workerId, attempt, port: portOverride });
      ctx.exitCallbacks.set(workerId, onExit);
      if (ctx.autoReady) queueMicrotask(() => onMessage(workerId, { type: 'ready' }));
      return { proc: {} as never, pid, stdout: emptyStream(), stderr: emptyStream() };
    },
    async killWorker(pid: number) {
      ctx.killed.push(pid);
      if (ctx.failKills) {
        throw new Error(`h70 kill failure: process ${pid} is still running after SIGKILL`);
      }
      return 'exited' as const;
    },
    isRunning() {
      return ctx.isRunning;
    },
  };

  m.logManager = {
    pipeOutput(_app: string, workerId: number) {
      // Mirrors LogWriter's constructor: mkdirSync / openSync / chmodSync all
      // run synchronously AFTER Bun.spawn has already produced a live child.
      if (ctx.failPipe?.(workerId, ctx.spawnAttempts.get(workerId) ?? 0)) {
        throw new Error(`h70 log wiring failure: worker ${workerId}`);
      }
    },
    closeAll() {},
    closeApp() {},
    closeWorker() {},
  };

  m.healthChecker = {
    onUnhealthy() {},
    offUnhealthy() {},
    startChecking(workerId: number) {
      ctx.monitorEvents.push(`start:${workerId}`);
    },
    stopChecking(workerId: number) {
      ctx.monitorEvents.push(`stopCheck:${workerId}`);
    },
    startHeartbeatMonitor(workerId: number) {
      ctx.monitorEvents.push(`startHb:${workerId}`);
    },
    stopHeartbeatMonitor(workerId: number) {
      ctx.monitorEvents.push(`stopHb:${workerId}`);
    },
    onHeartbeat() {},
    stopAll() {},
    getWorkerPort: () => undefined,
    isHeartbeatStale: () => false,
  };

  m.createProxyCluster = () => ({
    start() {},
    addWorker() {},
    removeWorker() {},
    stop() {
      ctx.proxyStops++;
    },
  });

  // WorkerHandler captured the real ProcessManager in its constructor; rebuild
  // it against the stub (same technique as h59 / test/core/master.test.ts).
  m.workerHandler = new WorkerHandler(m.processManager, m.crashRecovery, m.lifecycle);

  m.lifecycle.onStateChange((wid: number, from: WorkerState, to: WorkerState) => {
    ctx.transitions.push(`${wid}:${from}->${to}`);
  });

  // Observe when a parked `restartWorker` finishes its critical section, so the
  // "stale generation" test never has to guess at a sleep duration.
  const realLaunchDeps = m.launchDeps.bind(master);
  m.launchDeps = (): LaunchDeps => {
    const deps = realLaunchDeps() as LaunchDeps;
    const inner = deps.runExclusive;
    if (!inner) return deps;
    return {
      ...deps,
      runExclusive: <T>(name: string, fn: () => Promise<T>): Promise<T> =>
        inner(name, async () => {
          try {
            return await fn();
          } finally {
            ctx.exclusiveRuns++;
          }
        }),
    };
  };

  const h: Harness = { master, ctx };
  live.push(h);
  return h;
}

interface ConfigOpts {
  instances?: number;
  port?: number;
  proxy?: boolean;
  backoffInitial?: number;
}

function makeConfig(name: string, opts: ConfigOpts = {}): AppConfig {
  const instances = opts.instances ?? 1;
  return {
    name,
    script: 'app.ts',
    instances,
    maxRestarts: 10,
    maxRestartWindow: 60_000,
    minUptime: 60_000,
    killTimeout: 200,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    port: opts.port,
    // multiplier 1 keeps every backoff delay equal to `initial`, so the test
    // does not have to model an exponential curve.
    backoff: { initial: opts.backoffInitial ?? 60, multiplier: 1, max: 5_000 },
    ...(opts.proxy
      ? {
          clustering: {
            enabled: true as const,
            strategy: 'proxy' as const,
            rollingRestart: { batchSize: 1, batchDelay: 0 },
          },
        }
      : {}),
  };
}

function managedOf(master: MasterOrchestrator, name: string): ManagedApp {
  const managed = (master as any).apps.get(name) as ManagedApp | undefined;
  if (!managed) throw new Error(`h70: app "${name}" is not registered`);
  trackedApps.push(managed);
  return managed;
}

afterEach(async () => {
  for (const h of live) {
    h.ctx.failKills = false;
    h.ctx.failSpawn = null;
    h.ctx.failPipe = null;
    await h.master.shutdown('SIGTERM').catch(() => undefined);
  }
  live.length = 0;
  // Belt-and-suspenders: no timer from an aborted teardown may outlive a test.
  for (const managed of trackedApps) {
    for (const t of managed.readyTimers.values()) clearTimeout(t);
    for (const t of managed.stableTimers.values()) clearTimeout(t);
    managed.readyTimers.clear();
    managed.stableTimers.clear();
  }
  trackedApps.length = 0;
});

// ---------------------------------------------------------------------------
// 1. stale restart generation
// ---------------------------------------------------------------------------

test('a stale crash-restart must not orphan the generation restartApp just spawned', async () => {
  const { master, ctx } = harness();
  const name = 'h70-stale-generation';
  // instances 1 + a public port => restartWorker takes the PORT_RELEASE_DELAY
  // sleep (no reusePort, no proxy) which is where the stale restart parks.
  const config = makeConfig(name, { instances: 1, port: 39_101 });

  await master.startApp(config);
  const managed = managedOf(master, name);
  await waitFor('worker 0 online', () => managed.workers[0]?.state === 'online');

  const firstPid = ctx.spawns[0]!.pid;
  expect(managed.spawned.get(0)?.pid).toBe(firstPid);

  // Worker 0 crashes -> handleExit arms the backoff timer.
  ctx.exitCallbacks.get(0)?.(0, 1, null);
  expect(managed.workers[0]?.state).toBe('crashed');

  // The backoff timer fires and restartWorker parks in its sleep.
  await waitFor('crash-restart in flight', () => managed.restartingWorkers.has(0));
  const runsBefore = ctx.exclusiveRuns;
  // The WorkerInfo the parked restart is holding. restartApp must replace it.
  const staleWorker = managed.workers[0]!;

  // A hard restart lands mid-flight. It clears workers/spawned and respawns
  // worker id 0 on the same ManagedApp, so the parked restart wakes up holding
  // a WorkerInfo the app no longer tracks — but sharing its id.
  await master.restartApp(config.name);

  const replacement = ctx.spawns[ctx.spawns.length - 1]!;
  expect(replacement.workerId).toBe(0);
  expect(replacement.pid).not.toBe(firstPid);
  // Precondition of the whole scenario: same id, different generation. Without
  // this the resurrection guard would never even be reached.
  expect(managed.workers[0]).not.toBe(staleWorker);
  expect(managed.workers[0]?.pid).toBe(replacement.pid);
  expect(managed.spawned.get(0)?.pid).toBe(replacement.pid);

  // Let the parked restart resume and run its resurrection guard.
  await waitFor('parked restart resumed', () => ctx.exclusiveRuns > runsBefore);

  // The guard must abort the launch — counted including throwing spawns, so a
  // resurrected stale worker cannot hide behind a failed spawn.
  expect(ctx.spawnAttempts.get(0)).toBe(2);
  expect(ctx.spawns.length).toBe(2);
  expect(staleWorker.state).not.toBe('online');
  // ...without dropping the handle the NEW generation owns.
  expect(managed.spawned.get(0)?.pid).toBe(replacement.pid);

  // Which is the only reason a stop can still reach that process.
  await master.stopApp(name);
  expect(ctx.killed).toContain(replacement.pid);
  expect(managed.spawned.size).toBe(0);
});

// ---------------------------------------------------------------------------
// 2. a relaunch whose spawn throws synchronously
// ---------------------------------------------------------------------------

test('a relaunch that throws synchronously lands in the crash machinery, not in limbo', async () => {
  const { master, ctx } = harness();
  const name = 'h70-relaunch-throws';
  // No port => restartWorker skips the port-release sleep, keeping the two
  // backoff cycles fast.
  const config = makeConfig(name, { instances: 1, backoffInitial: 60 });

  await master.startApp(config);
  const managed = managedOf(master, name);
  await waitFor('worker 0 online', () => managed.workers[0]?.state === 'online');

  // Only the relaunch fails (ENOENT/EAGAIN class); the retry after it succeeds.
  ctx.failSpawn = (workerId, attempt) => workerId === 0 && attempt === 2;

  ctx.exitCallbacks.get(0)?.(0, 1, null);
  expect(managed.workers[0]?.state).toBe('crashed');

  await waitFor('relaunch attempted', () => (ctx.spawnAttempts.get(0) ?? 0) >= 2);

  // The failed relaunch must be reported as a crash of a 'starting' worker, so
  // backoff / maxRestarts owns the retry. Read from the transition log rather
  // than polling, so the assertion can't miss a short-lived state.
  await waitFor('starting->crashed recorded', () =>
    ctx.transitions.includes('0:starting->crashed'),
  );

  // ...and the backoff timer really does bring the worker back.
  await waitFor('worker 0 back online', () => managed.workers[0]?.state === 'online');

  // Exactly one failed relaunch, routed through the crash machinery exactly
  // once (a double-report would double-count consecutiveCrashes / maxRestarts).
  expect(ctx.transitions.filter((t) => t === '0:starting->crashed').length).toBe(1);

  expect(ctx.spawnAttempts.get(0)).toBe(3);
  const lastSpawn = ctx.spawns[ctx.spawns.length - 1]!;
  expect(managed.spawned.get(0)?.pid).toBe(lastSpawn.pid);
  expect(managed.workers[0]?.pid).toBe(lastSpawn.pid);
  // No stale launch token from the throwing attempt may shadow the live one:
  // otherwise the fresh worker's ready/exit callbacks are silently dropped.
  expect(managed.launchTokens.has(0)).toBe(true);

  // And the public view agrees — this is the surface that reported 'running'
  // over a worker that had no process at all.
  const status = master.getAppStatus(name);
  expect(status?.status).toBe('running');
  expect(status?.workers.map((w) => [w.state, w.pid])).toEqual([['online', lastSpawn.pid]]);

  await master.stopApp(name);
  expect(ctx.killed).toContain(lastSpawn.pid);
  expect(master.getAppStatus(name)?.status).toBe('stopped');
});

// ---------------------------------------------------------------------------
// 3. rollbackApp when the SIGKILL escalation fails
// ---------------------------------------------------------------------------

test('rollbackApp frees the app name, proxy and ports, and keeps the original error', async () => {
  const { master, ctx } = harness();
  const priv = master as any;
  const name = 'h70-rollback';
  const config = makeConfig(name, { instances: 2, port: 39_103, proxy: true });

  // Worker 1's spawn fails on the first start attempt, and every kill throws
  // (a child that survived SIGKILL) — which is what used to abort the rollback.
  ctx.failSpawn = (workerId, attempt) => workerId === 1 && attempt === 1;
  ctx.failKills = true;

  const error = await master.startApp(config).then(
    () => null,
    (err: unknown) => err,
  );

  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  // The rollback's own failure must never mask the real start failure.
  expect(message).toContain('h70 spawn failure: worker 1');
  expect(message).not.toContain('h70 kill failure');
  // Sanity: the rollback really did try to kill the one worker that HAD
  // spawned (worker 0) — i.e. the throwing path was actually exercised.
  expect(ctx.spawns.map((s) => s.workerId)).toEqual([0]);
  expect(ctx.killed).toEqual([ctx.spawns[0]!.pid]);
  // Proxy strategy => worker 0 was handed a reserved internal port, so the
  // "no port stays reserved" assertion below is about a non-empty set.
  expect(ctx.spawns[0]!.port).toBeGreaterThanOrEqual(INTERNAL_PORT_BASE);

  // Global bookkeeping must be released despite the failed kill.
  expect(priv.apps.has(name)).toBe(false);
  expect(ctx.proxyStops).toBe(1);
  expect([...(priv.allocatedInternalPorts as Set<number>)]).toEqual([]);
  expect(master.getAppStatus(name)).toBeNull();

  // Therefore the failed start is retryable instead of wedged for the life of
  // the daemon ("App ... is already running.").
  ctx.failSpawn = null;
  ctx.failKills = false;
  await master.startApp(config);
  const managed = managedOf(master, name);
  expect(managed.workers.length).toBe(2);
  expect(managed.spawned.size).toBe(2);
  // The retry re-reserved its own ports and re-armed its own proxy, so the
  // released bookkeeping was genuinely reusable, not merely absent.
  expect((priv.allocatedInternalPorts as Set<number>).size).toBe(2);
  expect(ctx.proxyStops).toBe(1);

  await master.stopApp(name);
  expect(ctx.proxyStops).toBe(2);
  expect([...(priv.allocatedInternalPorts as Set<number>)]).toEqual([]);
});

// ---------------------------------------------------------------------------
// 4. partially-launched relaunch (spawn lands, wiring throws)
// ---------------------------------------------------------------------------

test('a relaunch that dies in the log wiring must not orphan the live child', async () => {
  // `launchWorker` is NOT atomic: `Bun.spawn` is its first statement, and the
  // wiring after it (LogWriter -> mkdirSync/openSync/chmodSync) throws on
  // EACCES / ENOSPC / EMFILE with the child ALREADY RUNNING. Dropping the
  // spawned handle there would leave a process `stopAllWorkers` can never
  // reach — the very orphan class test 1 exists to prevent, one function down.
  const { master, ctx } = harness();
  const name = 'h70-partial-launch';
  const config = makeConfig(name, { instances: 1, backoffInitial: 40 });

  await master.startApp(config);
  const managed = managedOf(master, name);
  await waitFor('worker 0 online', () => managed.workers[0]?.state === 'online');
  const firstPid = ctx.spawns[0]!.pid;

  // Only the RELAUNCH (attempt 2) fails its wiring; the initial spawn stands.
  ctx.failPipe = (workerId, attempt) => workerId === 0 && attempt === 2;

  ctx.exitCallbacks.get(0)?.(0, 1, null);
  await waitFor('relaunch attempted', () => (ctx.spawnAttempts.get(0) ?? 0) >= 2);

  const partialPid = ctx.spawns[1]!.pid;
  expect(partialPid).not.toBe(firstPid);

  // INVARIANT: the child that WAS spawned is signalled, not silently dropped.
  await waitFor('partial child killed', () => ctx.killed.includes(partialPid));
  // Handle released only because the kill succeeded.
  expect(managed.spawned.has(0)).toBe(false);
  // The stale launch token is dropped, so the partial child's own exit callback
  // cannot re-enter handleExit and double-count the crash.
  expect(managed.launchTokens.has(0)).toBe(false);
  expect(ctx.transitions.filter((t) => t === '0:starting->crashed').length).toBe(1);

  // The monitors are armed one statement BEFORE the log wiring that threw, so
  // the failed relaunch must stop them: nothing else will, and a heartbeat
  // interval left running past a `give-up` decision leaks for the daemon's
  // whole life. (The launch that threw is the second `startHb:0`.)
  const monitorTail = ctx.monitorEvents.slice(ctx.monitorEvents.lastIndexOf('startHb:0'));
  expect(monitorTail).toContain('stopHb:0');
  expect(monitorTail).toContain('stopCheck:0');

  // …and the worker is not stranded: backoff brings it back online.
  ctx.failPipe = null;
  await waitFor('worker 0 back online', () => managed.workers[0]?.state === 'online');
  const finalPid = managed.spawned.get(0)?.pid;
  expect(finalPid).toBeDefined();
  expect(finalPid).not.toBe(partialPid);
  expect(master.getAppStatus(name)?.status).toBe('running');

  // The recovered worker is fully tracked, so stopApp reaches it.
  const killedBefore = ctx.killed.length;
  ctx.isRunning = true;
  await master.stopApp(name);
  expect(ctx.killed.slice(killedBefore)).toContain(finalPid as number);
});
