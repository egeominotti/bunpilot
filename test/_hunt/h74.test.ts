// ---------------------------------------------------------------------------
// H74 — control `metrics` must honour the app name + the daemon must persist
//       worker PIDs for CLI-started apps
// ---------------------------------------------------------------------------
//
// BUG A — src/control/handlers.ts, 'metrics' handler
//
//     handlers.set('metrics', async (_args) => {
//       const metrics = ctx.getMetrics();
//       return createResponse('', metrics);   // args ignored
//     });
//
//   `bunpilot metrics <name>` sends `{ name }` (src/cli/commands/metrics.ts),
//   but the handler threw the argument away and answered with the WHOLE fleet.
//   A typo (`bunpilot metrics wbe`) therefore exited 0 and printed every app's
//   workers instead of failing — the operator reads another app's numbers and
//   believes they belong to the app they asked about.
//
//   INVARIANT: a `metrics` request naming an app resolves to exactly that app,
//   or fails with `App not found: <name>`. A request with no name is still the
//   whole fleet, returned verbatim.
//
// BUG B — src/daemon/boot.ts, worker-pid persistence
//
//   `persistWorkers()` had exactly ONE call site: the boot-time restore loop.
//   Every app started through the control socket (`bunpilot start ...`) left
//   the `workers` table empty, so `reconcileOrphanedWorkers()` — which reads
//   those rows to identify the previous generation — was a no-op. After a
//   SIGKILLed daemon the old workers kept running, reparented to init, and the
//   next boot stacked a fresh generation on top of them (the h11 failure mode,
//   reachable for every CLI-started app).
//
//   INVARIANT: the persisted `workers` set mirrors the live worker set after
//   every lifecycle transition — start persists the live PIDs, restart replaces
//   them with the new PIDs, stop clears them.
//
// Bug B drives the REAL bootDaemon + REAL unix control socket + REAL
// SqliteStore in a subprocess with an isolated BUNPILOT_HOME under
// /private/tmp (same harness as h67).
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig, AppStatus, WorkerInfo } from '../../src/config/types';
import {
  type CommandContext,
  createCommandHandlers,
  type Handler,
} from '../../src/control/handlers';

// ---------------------------------------------------------------------------
// Part A — metrics handler filtering (in-process, stubbed CommandContext)
// ---------------------------------------------------------------------------

function createMockContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    listApps: () => [],
    getApp: () => undefined,
    startApp: async () => {},
    stopApp: async () => {},
    restartApp: async () => {},
    reloadApp: async () => {},
    deleteApp: async () => {},
    getMetrics: () => [],
    getLogs: () => [],
    dumpState: () => ({}),
    shutdown: async () => {},
    ...overrides,
  };
}

function fakeApp(name: string, pid: number): AppStatus {
  const worker: WorkerInfo = {
    id: 0,
    pid,
    state: 'online',
    startedAt: 1,
    readyAt: 1,
    restartCount: 0,
    consecutiveCrashes: 0,
    lastCrashAt: null,
    exitCode: null,
    signalCode: null,
    memory: null,
    cpu: null,
  };
  return {
    name,
    status: 'running',
    workers: [worker],
    config: { name, script: `${name}.ts` } as AppConfig,
    startedAt: 1,
  };
}

const FLEET: AppStatus[] = [fakeApp('web', 101), fakeApp('api', 202)];

function metricsHandler(metrics: AppStatus[]): Handler {
  const handlers = createCommandHandlers(createMockContext({ getMetrics: () => metrics }));
  const handler = handlers.get('metrics');
  if (!handler) throw new Error('metrics handler missing');
  return handler;
}

test('metrics without a name returns the whole fleet', async () => {
  const res = await metricsHandler(FLEET)({});

  expect(res.ok).toBe(true);
  expect((res.data as AppStatus[]).map((a) => a.name)).toEqual(['web', 'api']);
});

test('metrics with a name returns exactly that app', async () => {
  const first = await metricsHandler(FLEET)({ name: 'web' });

  expect(first.ok).toBe(true);
  // The whole point of the fix: NOT the fleet, exactly one entry, and it is the
  // one that was asked for.
  expect(first.data).toEqual([FLEET[0]]);
  expect((first.data as AppStatus[]).length).toBe(1);

  // 'web' is FLEET[0], so the case above also passes for a handler that ignores
  // the name and answers `[metrics[0]]`. Ask for the SECOND app to force a real
  // lookup: the answer must be 'api' with api's worker pid, never 'web'.
  const second = await metricsHandler(FLEET)({ name: 'api' });

  expect(second.ok).toBe(true);
  expect(second.data).toEqual([FLEET[1]]);
  expect((second.data as AppStatus[])[0]?.name).toBe('api');
  expect((second.data as AppStatus[])[0]?.workers[0]?.pid).toBe(202);
});

test('metrics with an unknown name fails with app-not-found', async () => {
  const res = await metricsHandler(FLEET)({ name: 'wbe' });

  // Before the fix a typo answered ok:true with all 2 apps, so the CLI exited 0.
  expect(res.ok).toBe(false);
  expect(res.error).toBe('App not found: wbe');
  expect(res.data).toBeUndefined();
});

test('an empty fleet answers with nothing instead of a stale payload', async () => {
  const unnamed = await metricsHandler([])({});

  expect(unnamed.ok).toBe(true);
  expect(unnamed.data).toEqual([]);

  // Nothing to match against still has to fail loudly rather than answer ok
  // with an empty list the CLI would print as "no data".
  const named = await metricsHandler([])({ name: 'web' });

  expect(named.ok).toBe(false);
  expect(named.error).toBe('App not found: web');
});

// ---------------------------------------------------------------------------
// Part B — daemon worker-pid persistence (real daemon subprocess)
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, '..', '..');
// Short base path (unix socket length cap) with a portable fallback.
const TMP_BASE = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();
const tmpRoot = mkdtempSync(join(TMP_BASE, 'bunpilot-h74-'));
// Piped stdio: `Bun.Subprocess` (as h71 uses it) types stdout/stderr as the
// readable streams this harness drains.
let child: Bun.Subprocess | null = null;

afterAll(() => {
  try {
    child?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const DRIVER_SOURCE = String.raw`
const ROOT = process.env.H74_ROOT;
const HOME = process.env.BUNPILOT_HOME;
const APP  = JSON.parse(process.env.H74_APP);

const { bootDaemon } = await import(ROOT + '/src/daemon/boot.ts');
const { SqliteStore } = await import(ROOT + '/src/store/sqlite.ts');

const SOCK = HOME + '/bunpilot.sock';
const DB   = HOME + '/bunpilot.db';

function send(cmd, args) {
  const id = crypto.randomUUID();
  const payload = JSON.stringify({ id, cmd, args }) + '\n';
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('control request timed out')), 15000);
    Bun.connect({
      unix: SOCK,
      socket: {
        open(s) { s.write(payload); },
        data(s, raw) {
          buf += new TextDecoder().decode(raw);
          let nl = buf.indexOf('\n');
          while (nl !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim()) {
              const msg = JSON.parse(line);
              if (msg.id === id) { clearTimeout(timer); resolve(msg); s.end(); return; }
            }
            nl = buf.indexOf('\n');
          }
        },
        error(_s, err) { clearTimeout(timer); reject(err); },
      },
    }).catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/** Live worker pids, straight from the orchestrator via the control socket. */
async function livePids() {
  const res = await send('status', { name: APP.name });
  if (!res.ok) return null;
  return (res.data.workers || [])
    .map((w) => w.pid)
    .filter((p) => typeof p === 'number' && p > 0)
    .sort((a, b) => a - b);
}

/** Persisted worker pids, read back through the REAL store. */
function storedPids() {
  const store = new SqliteStore(DB);
  try {
    return store
      .getWorkers(APP.name)
      .map((w) => w.pid)
      .filter((p) => typeof p === 'number' && p > 0)
      .sort((a, b) => a - b);
  } finally {
    store.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await pred();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await sleep(100);
  }
}

const out = {};
try {
  await bootDaemon();

  // -- start --------------------------------------------------------------
  const started = await send('start', { name: APP.name, config: APP });
  out.startOk = started.ok === true;
  out.startError = started.error ?? null;
  out.liveAfterStart = await livePids();
  out.storedAfterStart = storedPids();

  // -- SIGKILL one worker: the respawn happens with NO command in flight, so
  //    only the periodic refresh can bring the persisted set back in sync.
  const victim = out.liveAfterStart[0];
  try { process.kill(victim, 'SIGKILL'); } catch { /* already gone */ }
  out.victim = victim;
  out.liveAfterCrash = await pollUntil(async () => {
    const pids = await livePids();
    if (!pids || pids.length !== APP.instances || pids.includes(victim)) return null;
    return pids;
  }, 15000);
  if (out.liveAfterCrash) {
    const target = JSON.stringify(out.liveAfterCrash);
    out.storedAfterCrash = await pollUntil(
      async () => {
        const pids = storedPids();
        return JSON.stringify(pids) === target ? pids : null;
      },
      // WORKER_SYNC_INTERVAL is 10s; allow two ticks of slack.
      22000,
    );
  }

  // -- restart ------------------------------------------------------------
  const restarted = await send('restart', { name: APP.name });
  out.restartOk = restarted.ok === true;
  out.liveAfterRestart = await livePids();
  out.storedAfterRestart = storedPids();

  // -- metrics filter, end to end over the real socket ---------------------
  const hit = await send('metrics', { name: APP.name });
  out.metricsNamed = hit.ok === true && Array.isArray(hit.data)
    ? hit.data.map((a) => a.name)
    : ['<not-an-array>'];
  const miss = await send('metrics', { name: APP.name + '-typo' });
  out.metricsMissOk = miss.ok === true;
  out.metricsMissError = miss.error ?? null;

  // -- stop ---------------------------------------------------------------
  const stopped = await send('stop', { name: APP.name });
  out.stopOk = stopped.ok === true;
  out.storedAfterStop = storedPids();
} catch (err) {
  out.fatal = String(err && err.stack ? err.stack : err);
} finally {
  console.log('H74_RESULT:' + JSON.stringify(out));
  send('kill-daemon', {}).catch(() => {});
  setTimeout(() => process.exit(0), 2000);
}
`;

interface DriverResult {
  startOk?: boolean;
  startError?: string | null;
  liveAfterStart?: number[] | null;
  storedAfterStart?: number[];
  victim?: number;
  liveAfterCrash?: number[] | null;
  storedAfterCrash?: number[] | null;
  restartOk?: boolean;
  liveAfterRestart?: number[] | null;
  storedAfterRestart?: number[];
  stopOk?: boolean;
  storedAfterStop?: number[];
  metricsNamed?: string[];
  metricsMissOk?: boolean;
  metricsMissError?: string | null;
  fatal?: string;
}

const APP_NAME = 'h74app';
const INSTANCES = 2;

let driverRun: Promise<DriverResult> | null = null;

function runDriver(): Promise<DriverResult> {
  driverRun ??= execDriver();
  return driverRun;
}

async function execDriver(): Promise<DriverResult> {
  const scriptPath = join(tmpRoot, 'worker.js');
  writeFileSync(scriptPath, 'setInterval(() => {}, 1000);\n');

  const app = {
    name: APP_NAME,
    script: scriptPath,
    instances: INSTANCES,
    cwd: tmpRoot,
    // Short minUptime so a deliberately SIGKILLed worker is treated as a normal
    // crash-restart rather than an unstable app.
    minUptime: 100,
    healthCheck: { enabled: false },
    // No metrics server: the daemon boots with no config, so it never binds the
    // metrics port and must not be asked to.
    metrics: { enabled: false },
  };

  const driverPath = join(tmpRoot, 'driver.mjs');
  writeFileSync(driverPath, DRIVER_SOURCE);

  const proc = Bun.spawn(['bun', 'run', driverPath], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      BUNPILOT_HOME: join(tmpRoot, 'home'),
      H74_ROOT: REPO_ROOT,
      H74_APP: JSON.stringify(app),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  child = proc;

  const killer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 75_000);

  // Drain both pipes concurrently: a stderr-chatty driver can fill its stderr
  // pipe and deadlock while we are still blocked on stdout.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(killer);

  const line = stdout.split('\n').find((l) => l.startsWith('H74_RESULT:'));
  if (!line) {
    throw new Error(
      `driver produced no result\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  const result = JSON.parse(line.slice('H74_RESULT:'.length)) as DriverResult;
  if (result.fatal) {
    throw new Error(`driver failed: ${result.fatal}\n--- stderr ---\n${stderr}`);
  }
  return result;
}

test('a CLI-started app persists one worker row per live worker PID', async () => {
  const r = await runDriver();

  expect(`startOk=${r.startOk} error=${r.startError}`).toBe('startOk=true error=null');
  expect(r.liveAfterStart?.length).toBe(INSTANCES);

  // INVARIANT: the `workers` table mirrors the live set. Before the fix
  // ctx.startApp never called persistWorkers, so this was [].
  expect(r.storedAfterStart).toEqual(r.liveAfterStart as number[]);
}, 90_000);

test('a crash-restart with no command in flight is re-synced by the refresh interval', async () => {
  const r = await runDriver();

  // Precondition: the orchestrator really did respawn the SIGKILLed worker
  // under a new PID, outside of any control command. Assert the shape too, so
  // a null/undefined `liveAfterCrash` can never make the comparison below pass
  // by matching an equally absent `storedAfterCrash`.
  expect(r.liveAfterCrash?.length).toBe(INSTANCES);
  expect(r.liveAfterCrash?.includes(r.victim as number)).toBe(false);

  // The persisted set therefore HAD to change; if it did not, the assertion
  // below would be comparing two identical stale arrays.
  expect(r.liveAfterCrash).not.toEqual(r.storedAfterStart as number[]);

  // INVARIANT: refreshPersistedWorkers() converges the persisted set onto the
  // new PIDs, so boot-time orphan reconciliation cannot chase a dead PID.
  expect(r.storedAfterCrash).toEqual(r.liveAfterCrash as number[]);
}, 90_000);

test('restart replaces the persisted PIDs with the new generation', async () => {
  const r = await runDriver();

  expect(r.restartOk).toBe(true);
  expect(r.liveAfterRestart?.length).toBe(INSTANCES);
  // A restart really did hand out fresh PIDs...
  expect(r.liveAfterRestart).not.toEqual(r.liveAfterStart as number[]);
  // ...and the store followed, with no stale rows left behind.
  expect(r.storedAfterRestart).toEqual(r.liveAfterRestart as number[]);
}, 90_000);

test('stop clears the persisted worker rows', async () => {
  const r = await runDriver();

  // The transition is only meaningful if rows existed to begin with.
  expect(r.storedAfterRestart?.length).toBe(INSTANCES);
  expect(r.stopOk).toBe(true);
  // ctx.stopApp must call store.clearWorkers: a stopped app has no live
  // workers, so a leftover row would make the next boot hunt a dead PID.
  expect(r.storedAfterStop).toEqual([]);
}, 90_000);

test('the daemon filters metrics by app name over the real control socket', async () => {
  const r = await runDriver();

  expect(r.metricsNamed).toEqual([APP_NAME]);
  expect(`ok=${r.metricsMissOk} error=${r.metricsMissError}`).toBe(
    `ok=false error=App not found: ${APP_NAME}-typo`,
  );
}, 90_000);

// ---------------------------------------------------------------------------
// Part C — refresh guards + persistence on a failed lifecycle command
// ---------------------------------------------------------------------------
//
// Part B pins that the persisted set CONVERGES on the live one. The guards
// `refreshPersistedWorkers` grew around that convergence — and the `finally`
// that persists a half-done restart — are a different contract: they say WHEN
// the refresh must keep its hands off the table, and when a command that threw
// must still record what it replaced. Delete any of them and Part B stays green.
//
//   1. `if (app.status !== 'running') continue;`
//      A stopped app keeps its (dead) worker entries in `master.listApps()`, so
//      the next 10s tick would silently UNDO the `store.clearWorkers()` that
//      ctx.stopApp just performed — handing the next boot a set of dead pids to
//      hunt (and, once the OS recycles them, to SIGKILL).
//
//   2. `if (app.workers.length === 0) continue;`
//      A running app with no workers is mid-restart: `restartAppUnlocked` sets
//      `managed.workers = []` before respawning, and `toAppStatus` reports that
//      as 'running' (startedAt is set). Persisting the empty set there erases
//      the pids of a generation that may still be alive — exactly the rows
//      boot-time reconciliation needs.
//
//   3. the `lastSynced` signature map.
//      Without it an idle daemon runs a DELETE + N INSERT transaction for every
//      app every 10 seconds, forever.
//
//   4. `persistWorkers` in ctx.restartApp's `finally`.
//      A restart that throws AFTER the orchestrator swapped the pids (the store
//      write that follows it fails) must still record the generation it did
//      replace; leaving the old pids on record sends the next boot after a
//      SIGKILLed daemon hunting processes that no longer exist.
//
// `refreshPersistedWorkers` is module-private, so this drives the REAL
// bootDaemon in a subprocess with an isolated BUNPILOT_HOME (Part B's harness)
// and asserts on the `workers` table through the REAL SqliteStore. The
// ProcessManager is stubbed the way h70 stubs it, one level up: the daemon owns
// its MasterOrchestrator, so the stub lives on the prototype. Nothing real is
// spawned. The 10s sync interval is captured out of `setInterval` at boot, so
// ticks are fired on demand instead of waited on, and `replaceWorkers` is
// wrapped into a write counter so "did not rewrite" is observed, not inferred.
// ---------------------------------------------------------------------------

const tmpRootC = mkdtempSync(join(TMP_BASE, 'bunpilot-h74c-'));
let childC: Bun.Subprocess | null = null;

afterAll(() => {
  try {
    childC?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmpRootC, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const DRIVER_C_SOURCE = String.raw`
const ROOT = process.env.H74C_ROOT;
const HOME = process.env.BUNPILOT_HOME;
const APPS = JSON.parse(process.env.H74C_APPS);

const SOCK = HOME + '/bunpilot.sock';
const DB   = HOME + '/bunpilot.db';

const { ProcessManager }     = await import(ROOT + '/src/core/process-manager.ts');
const { MasterOrchestrator } = await import(ROOT + '/src/core/master.ts');
const { SqliteStore }        = await import(ROOT + '/src/store/sqlite.ts');

// -- Process manager stub (h70's collaborator stub, applied on the prototype
//    because bootDaemon constructs the orchestrator itself) ------------------
let nextPid = 470001;
let stubSpawns = 0;
const alivePids = new Set();
const exitCallbacks = new Map();   // "<app>:<workerId>" -> onExit

const emptyStream = () => new ReadableStream({ start(c) { c.close(); } });

ProcessManager.prototype.spawnWorker = function (config, workerId, onMessage, onExit) {
  stubSpawns++;
  const pid = nextPid++;
  alivePids.add(pid);
  exitCallbacks.set(config.name + ':' + workerId, onExit);
  queueMicrotask(() => onMessage(workerId, { type: 'ready' }));
  return { proc: {}, pid, stdout: emptyStream(), stderr: emptyStream() };
};
ProcessManager.prototype.killWorker = async function (pid) {
  alivePids.delete(pid);
  return 'exited';
};
ProcessManager.prototype.isRunning = function (pid) { return alivePids.has(pid); };

// -- Store spies ----------------------------------------------------------
/** replaceWorkers calls per app: the DELETE + N INSERT transaction under test. */
const writeCounts = new Map();
const realReplaceWorkers = SqliteStore.prototype.replaceWorkers;
SqliteStore.prototype.replaceWorkers = function (appName, workers) {
  writeCounts.set(appName, (writeCounts.get(appName) || 0) + 1);
  return realReplaceWorkers.call(this, appName, workers);
};
const writes = (name) => writeCounts.get(name) || 0;

/** Arm a one-shot failure of the store write ctx.restartApp does after master. */
let failStatusWriteFor = null;
const realUpdateAppStatus = SqliteStore.prototype.updateAppStatus;
SqliteStore.prototype.updateAppStatus = function (name, status) {
  if (failStatusWriteFor === name) {
    failStatusWriteFor = null;
    throw new Error('h74c: simulated store failure marking ' + name + ' running');
  }
  return realUpdateAppStatus.call(this, name, status);
};

// -- The mid-restart window: a RUNNING app whose workers array is momentarily
//    empty. restartAppUnlocked opens and closes it synchronously, so no timer
//    can ever sample it from the outside; the snapshot the refresh reads is
//    therefore forged from the app's real one, emptying only its worker array.
let emptyWorkersFor = null;
let emptyWorkersView = null;
const realListApps = MasterOrchestrator.prototype.listApps;
const realGetAppStatus = MasterOrchestrator.prototype.getAppStatus;
MasterOrchestrator.prototype.listApps = function () {
  const apps = realListApps.call(this);
  if (emptyWorkersFor === null) return apps;
  return apps.map((app) => {
    if (app.name !== emptyWorkersFor) return app;
    // Recorded so the test can prove the refresh really saw status 'running'
    // over an empty worker set (and that it was non-empty a moment earlier).
    emptyWorkersView = { status: app.status, liveWorkers: app.workers.length };
    return { ...app, workers: [] };
  });
};
MasterOrchestrator.prototype.getAppStatus = function (name) {
  const app = realGetAppStatus.call(this, name);
  if (app && name === emptyWorkersFor) return { ...app, workers: [] };
  return app;
};

// -- Capture the 10s worker-sync tick -------------------------------------
let tick = null;
let tickCandidates = 0;
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function (fn, ms, ...rest) {
  if (ms === 10000) {
    tickCandidates++;
    if (tick === null) {
      tick = fn;
      // A real Timer (bootDaemon unrefs it and clearInterval()s it on cleanup)
      // that never fires by itself: every tick below is explicit.
      return realSetInterval(() => {}, 2000000000);
    }
  }
  return realSetInterval(fn, ms, ...rest);
};

const { bootDaemon } = await import(ROOT + '/src/daemon/boot.ts');

function send(cmd, args) {
  const id = crypto.randomUUID();
  const payload = JSON.stringify({ id, cmd, args }) + '\n';
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('control request timed out')), 15000);
    Bun.connect({
      unix: SOCK,
      socket: {
        open(s) { s.write(payload); },
        data(s, raw) {
          buf += new TextDecoder().decode(raw);
          let nl = buf.indexOf('\n');
          while (nl !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim()) {
              const msg = JSON.parse(line);
              if (msg.id === id) { clearTimeout(timer); resolve(msg); s.end(); return; }
            }
            nl = buf.indexOf('\n');
          }
        },
        error(_s, err) { clearTimeout(timer); reject(err); },
      },
    }).catch((err) => { clearTimeout(timer); reject(err); });
  });
}

/** Persisted rows, read back through the REAL store on its own connection. */
function storedRows(name) {
  const store = new SqliteStore(DB);
  try {
    return store.getWorkers(name).map((w) => ({
      id: w.worker_id,
      state: w.state,
      pid: w.pid,
      startedAt: w.started_at,
    }));
  } finally {
    store.close();
  }
}
const storedPids = (name) =>
  storedRows(name)
    .map((r) => r.pid)
    .filter((p) => typeof p === 'number' && p > 0)
    .sort((a, b) => a - b);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollUntil(pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await pred();
    if (value !== null) return value;
    if (Date.now() >= deadline) return null;
    await sleep(20);
  }
}

async function startApp(config) {
  const res = await send('start', { name: config.name, config });
  if (!res.ok) throw new Error('start failed for ' + config.name + ': ' + res.error);
}

/** Settle the app: every worker online with a pid, so no signature can move. */
async function waitOnline(name, count) {
  const pids = await pollUntil(async () => {
    const res = await send('status', { name });
    if (!res.ok) return null;
    const workers = res.data.workers || [];
    if (workers.length !== count) return null;
    if (!workers.every((w) => w.state === 'online' && typeof w.pid === 'number' && w.pid > 0)) {
      return null;
    }
    return workers.map((w) => w.pid).sort((a, b) => a - b);
  }, 15000);
  if (pids === null) throw new Error(name + ' never reached ' + count + ' online workers');
  return pids;
}

const out = { scenarios: {} };
try {
  await bootDaemon();
  globalThis.setInterval = realSetInterval;
  out.tickCandidates = tickCandidates;
  if (tick === null) throw new Error('worker sync tick was not captured');

  // -- 1. a STOPPED app must stay cleared ---------------------------------
  {
    const cfg = APPS.stopped;
    const s = {};
    await startApp(cfg);
    s.livePids = await waitOnline(cfg.name, cfg.instances);
    tick();                                   // baseline: lastSynced knows it
    s.storedBeforeStop = storedPids(cfg.name);

    const stopped = await send('stop', { name: cfg.name });
    s.stopOk = stopped.ok === true;
    s.stopError = stopped.error ?? null;
    s.storedAfterStop = storedPids(cfg.name);

    // The whole hazard: the orchestrator still reports the app, with its DEAD
    // worker entries and their pids, only with status !== 'running'.
    const after = await send('status', { name: cfg.name });
    s.statusAfterStop = after.ok ? after.data.status : null;
    s.deadPidsStillInMemory = after.ok
      ? (after.data.workers || []).map((w) => w.pid).filter((p) => p > 0).sort((a, b) => a - b)
      : [];

    const before = writes(cfg.name);
    tick();
    tick();
    s.storedAfterTicks = storedPids(cfg.name);
    s.writesDuringTicks = writes(cfg.name) - before;
    out.scenarios.stopped = s;
    await send('delete', { name: cfg.name });
  }

  // -- 2. a running app with NO workers must keep its rows -----------------
  {
    const cfg = APPS.empty;
    const s = {};
    await startApp(cfg);
    s.livePids = await waitOnline(cfg.name, cfg.instances);
    tick();                                   // baseline
    s.rowsBefore = storedRows(cfg.name);

    const before = writes(cfg.name);
    emptyWorkersFor = cfg.name;
    emptyWorkersView = null;
    try {
      tick();
    } finally {
      emptyWorkersFor = null;
    }
    s.viewSeen = emptyWorkersView;
    s.rowsAfter = storedRows(cfg.name);
    s.writesDuringTick = writes(cfg.name) - before;
    out.scenarios.empty = s;
    await send('delete', { name: cfg.name });
  }

  // -- 3. dirty check: an unchanged app is not rewritten -------------------
  {
    const cfg = APPS.sync;
    const s = {};
    await startApp(cfg);
    const first = await waitOnline(cfg.name, cfg.instances);

    const base = writes(cfg.name);
    tick();
    s.writesFirstTick = writes(cfg.name) - base;
    const rowsAfterFirst = storedRows(cfg.name);
    tick();
    tick();
    tick();
    s.writesIdleTicks = writes(cfg.name) - base - s.writesFirstTick;
    s.rowsUnmoved = JSON.stringify(storedRows(cfg.name)) === JSON.stringify(rowsAfterFirst);
    s.rowsAfterIdle = storedRows(cfg.name);

    // A pid change with NO command in flight: only the refresh can notice it,
    // which proves the counter above is not stuck at zero.
    const onExit = exitCallbacks.get(cfg.name + ':0');
    if (!onExit) throw new Error('no exit callback recorded for ' + cfg.name);
    onExit(0, 1, null);
    const respawned = await pollUntil(async () => {
      const res = await send('status', { name: cfg.name });
      if (!res.ok) return null;
      const workers = res.data.workers || [];
      if (workers.length !== 1) return null;
      const w = workers[0];
      if (w.state !== 'online' || !(w.pid > 0) || w.pid === first[0]) return null;
      return [w.pid];
    }, 15000);
    if (respawned === null) throw new Error(cfg.name + ' never respawned after the crash');
    s.pidBeforeCrash = first;
    s.pidAfterCrash = respawned;

    const dirty = writes(cfg.name);
    tick();
    s.writesAfterChange = writes(cfg.name) - dirty;
    s.storedAfterChange = storedPids(cfg.name);
    tick();
    tick();
    s.writesAfterReconverge = writes(cfg.name) - dirty - s.writesAfterChange;
    out.scenarios.dirty = s;
    await send('delete', { name: cfg.name });
  }

  // -- 4. a restart that throws after the pids were swapped ----------------
  {
    const cfg = APPS.boom;
    const s = {};
    await startApp(cfg);
    s.liveBefore = await waitOnline(cfg.name, cfg.instances);
    s.storedBefore = storedPids(cfg.name);

    // ctx.restartApp: the await on master.restartApp succeeds, the store write
    // right after it throws. Everything the restart replaced is already live.
    failStatusWriteFor = cfg.name;
    const res = await send('restart', { name: cfg.name });
    s.restartOk = res.ok === true;
    s.restartError = res.error ?? null;
    s.liveAfter = await waitOnline(cfg.name, cfg.instances);
    s.storedAfter = storedPids(cfg.name);
    out.scenarios.restartThrows = s;
    await send('delete', { name: cfg.name });
  }

  out.stubSpawns = stubSpawns;
} catch (err) {
  out.fatal = String(err && err.stack ? err.stack : err);
} finally {
  console.log('H74C_RESULT:' + JSON.stringify(out));
  send('kill-daemon', {}).catch(() => {});
  setTimeout(() => process.exit(0), 2000);
}
`;

interface StoredRow {
  id: number;
  state: string;
  pid: number | null;
  startedAt: number;
}

interface DriverCResult {
  tickCandidates?: number;
  stubSpawns?: number;
  fatal?: string;
  scenarios: {
    stopped?: {
      livePids: number[];
      storedBeforeStop: number[];
      stopOk: boolean;
      stopError: string | null;
      storedAfterStop: number[];
      statusAfterStop: string | null;
      deadPidsStillInMemory: number[];
      storedAfterTicks: number[];
      writesDuringTicks: number;
    };
    empty?: {
      livePids: number[];
      rowsBefore: StoredRow[];
      viewSeen: { status: string; liveWorkers: number } | null;
      rowsAfter: StoredRow[];
      writesDuringTick: number;
    };
    dirty?: {
      writesFirstTick: number;
      writesIdleTicks: number;
      rowsUnmoved: boolean;
      rowsAfterIdle: StoredRow[];
      pidBeforeCrash: number[];
      pidAfterCrash: number[];
      writesAfterChange: number;
      storedAfterChange: number[];
      writesAfterReconverge: number;
    };
    restartThrows?: {
      liveBefore: number[];
      storedBefore: number[];
      restartOk: boolean;
      restartError: string | null;
      liveAfter: number[];
      storedAfter: number[];
    };
  };
}

let driverCRun: Promise<DriverCResult> | null = null;

function runDriverC(): Promise<DriverCResult> {
  driverCRun ??= execDriverC();
  return driverCRun;
}

function appC(name: string, instances: number): Record<string, unknown> {
  return {
    name,
    script: join(tmpRootC, 'worker.js'),
    instances,
    cwd: tmpRootC,
    // A crashed worker must count as a normal crash-restart, and come back fast.
    minUptime: 100,
    backoff: { initial: 100, multiplier: 1, max: 1_000 },
    healthCheck: { enabled: false },
    // No ports anywhere: no listener is ever bound, so nothing can collide.
    metrics: { enabled: false },
  };
}

async function execDriverC(): Promise<DriverCResult> {
  // Never executed (the process manager is stubbed) but the config is validated
  // and the path is what a real spawn would use.
  writeFileSync(join(tmpRootC, 'worker.js'), 'setInterval(() => {}, 1000);\n');

  const driverPath = join(tmpRootC, 'driver.mjs');
  writeFileSync(driverPath, DRIVER_C_SOURCE);

  const proc = Bun.spawn(['bun', 'run', driverPath], {
    cwd: tmpRootC,
    env: {
      ...process.env,
      BUNPILOT_HOME: join(tmpRootC, 'home'),
      H74C_ROOT: REPO_ROOT,
      H74C_APPS: JSON.stringify({
        stopped: appC('h74c-stopped', 2),
        empty: appC('h74c-empty', 2),
        sync: appC('h74c-sync', 1),
        boom: appC('h74c-boom', 2),
      }),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  childC = proc;

  const killer = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 75_000);

  // Concurrent drain, same reason as Part B: sequential reads can deadlock on a
  // full stderr pipe.
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  clearTimeout(killer);

  const line = stdout.split('\n').find((l) => l.startsWith('H74C_RESULT:'));
  if (!line) {
    throw new Error(
      `driver C produced no result\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }
  const result = JSON.parse(line.slice('H74C_RESULT:'.length)) as DriverCResult;
  if (result.fatal) {
    throw new Error(`driver C failed: ${result.fatal}\n--- stderr ---\n${stderr}`);
  }
  return result;
}

test('the refresh harness drives the real daemon without spawning anything', async () => {
  const r = await runDriverC();

  // If the prototype stub had missed the daemon's ProcessManager, real `bun`
  // children would have been spawned and every assertion below would be
  // measuring the wrong system. It didn't, and it was used.
  expect(r.stubSpawns).toBeGreaterThan(0);
  // Exactly one 10s interval exists at boot (the worker sync), so the captured
  // callback cannot be some other component's timer.
  expect(r.tickCandidates).toBe(1);
}, 120_000);

test('a stopped app is not re-persisted by the periodic worker refresh', async () => {
  const r = await runDriverC();
  const s = r.scenarios.stopped;
  if (!s) throw new Error('stopped scenario missing');

  // Rows existed, so "still empty" below is a real transition, not a no-op.
  expect(s.storedBeforeStop).toEqual(s.livePids);
  expect(`ok=${s.stopOk} error=${s.stopError}`).toBe('ok=true error=null');
  expect(s.storedAfterStop).toEqual([]);

  // The hazard the guard exists for: the orchestrator STILL reports the app,
  // still carrying the dead pids, only with a non-running status.
  expect(s.statusAfterStop).toBe('stopped');
  expect(s.deadPidsStillInMemory).toEqual(s.livePids);

  // INVARIANT: the refresh skips non-running apps. Without the status guard the
  // tick would re-run persistWorkers over those dead pids and undo the
  // clearWorkers() that `stop` just did — the next boot would then hunt (and,
  // after PID reuse, SIGKILL) processes that are long gone.
  expect(s.storedAfterTicks).toEqual([]);
  expect(s.writesDuringTicks).toBe(0);
}, 120_000);

test('a running app with no workers keeps its persisted rows', async () => {
  const r = await runDriverC();
  const s = r.scenarios.empty;
  if (!s) throw new Error('empty-workers scenario missing');

  // Precondition: rows to lose, and a snapshot the refresh reads as RUNNING
  // with an empty worker set — the state restartApp passes through between
  // `managed.workers = []` and the respawn.
  expect(s.rowsBefore.map((row) => row.pid)).toEqual(s.livePids);
  expect(s.viewSeen).toEqual({ status: 'running', liveWorkers: 2 });

  // INVARIANT: the refresh skips a running app with no workers. Without the
  // guard persistWorkers would replace the rows with the empty set and wipe the
  // pids of a generation that may still be alive — precisely the rows
  // reconcileOrphanedWorkers needs to identify the previous generation.
  expect(s.rowsAfter).toEqual(s.rowsBefore);
  expect(s.writesDuringTick).toBe(0);
}, 120_000);

test('an unchanged app is not rewritten on every refresh tick', async () => {
  const r = await runDriverC();
  const s = r.scenarios.dirty;
  if (!s) throw new Error('dirty-check scenario missing');

  // The first tick after a start has no signature on record, so it syncs once.
  expect(s.writesFirstTick).toBe(1);

  // INVARIANT: three further ticks over an unchanged app perform no write at
  // all. Without the lastSynced dirty check each one runs a DELETE + N INSERT
  // transaction, forever, on a completely idle daemon.
  expect(s.writesIdleTicks).toBe(0);
  expect(s.rowsUnmoved).toBe(true);
  expect(s.rowsAfterIdle.map((row) => row.pid)).toEqual(s.pidBeforeCrash);

  // The counter is not simply stuck at zero: a pid that changes with no command
  // in flight is picked up by the very next tick...
  expect(s.pidAfterCrash).not.toEqual(s.pidBeforeCrash);
  expect(s.writesAfterChange).toBe(1);
  expect(s.storedAfterChange).toEqual(s.pidAfterCrash);
  // ...and then the daemon goes quiet again.
  expect(s.writesAfterReconverge).toBe(0);
}, 120_000);

test('a restart that throws after swapping pids still persists the new generation', async () => {
  const r = await runDriverC();
  const s = r.scenarios.restartThrows;
  if (!s) throw new Error('restart-throws scenario missing');

  expect(s.storedBefore).toEqual(s.liveBefore);
  // The restart really did fail...
  expect(s.restartOk).toBe(false);
  expect(s.restartError).toContain('simulated store failure');
  // ...after the orchestrator had already replaced every pid.
  expect(s.liveAfter.length).toBe(2);
  expect(s.liveAfter.some((pid) => s.liveBefore.includes(pid))).toBe(false);

  // INVARIANT: persistWorkers runs in ctx.restartApp's `finally`, so the pids
  // the restart DID replace are on record even though the command threw.
  // Without the finally the table would still hold `liveBefore` — two pids that
  // no longer exist, which the next boot after a SIGKILLed daemon would treat
  // as the orphan set to reconcile.
  expect(s.storedAfter).toEqual(s.liveAfter);
  expect(s.storedAfter).not.toEqual(s.storedBefore);
}, 120_000);
