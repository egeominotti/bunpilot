// ---------------------------------------------------------------------------
// h11 – Restore must reconcile the previous generation of workers
// ---------------------------------------------------------------------------
//
// Invariant (AGENTS.md): "Persistence reflects successful lifecycle
// transitions" + restore must converge the machine to the desired state, i.e.
// after a daemon boot exactly `instances` worker processes exist per app.
//
// Hypothesis under test: src/daemon/boot.ts:219 blindly calls
// master.startApp() for every row persisted with status='running'. Nothing
// records worker PIDs (SqliteStore.saveWorker/getWorkers are dead code) and
// nothing resets app status on abnormal daemon exit, so a daemon that dies by
// SIGKILL leaves its workers orphaned (reparented to init) and the next boot
// adds a whole new generation on top of them.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '../..');
const ENTRY = resolve(REPO_ROOT, 'src/index.ts');

// Deterministic-but-unique identifiers so pgrep can isolate this test's procs.
const TOKEN = `h11w${process.pid.toString(36)}${Date.now().toString(36)}`;

const root = mkdtempSync('/private/tmp/bp-h11-');
const scriptPath = resolve(root, `${TOKEN}.ts`);
const cfgPath = resolve(root, 'cfg.json');
const pidFile = resolve(root, 'bunpilot.pid');

const spawnedDaemonPids: number[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** PIDs of live worker processes belonging to this test (matched on script path). */
function workerPids(): number[] {
  const out = Bun.spawnSync(['pgrep', '-f', TOKEN]);
  return new TextDecoder()
    .decode(out.stdout)
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isSafeInteger(n) && n > 0 && !spawnedDaemonPids.includes(n));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(): number | null {
  try {
    const raw = readFileSync(pidFile, 'utf-8').trim();
    return /^[1-9]\d*$/.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

async function pollUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await sleep(50);
  }
  return pred();
}

/** Reserve a free high port, then release it (best effort ephemeral choice). */
function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

function startDaemon(logName: string): number {
  const fd = openSync(resolve(root, logName), 'a');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  env.BUNPILOT_HOME = root;
  delete env.BUNPILOT_SOCKET;
  env.BUNPILOT_DAEMON = '1';

  const child = Bun.spawn({
    cmd: [process.execPath, 'run', ENTRY, '__daemon', cfgPath],
    cwd: root,
    env,
    stdio: ['ignore', fd, fd],
    detached: true,
  });
  child.unref();
  spawnedDaemonPids.push(child.pid);
  return child.pid;
}

afterAll(() => {
  for (const pid of [...workerPids(), ...spawnedDaemonPids]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(root, { recursive: true, force: true });
});

test('daemon boot restore does not stack a new worker generation on orphans', async () => {
  const INSTANCES = 2;

  // A worker that simply stays alive and never writes to stdout, so it cannot
  // die from SIGPIPE when the daemon's pipe read-end disappears.
  writeFileSync(scriptPath, 'setInterval(() => {}, 1000);\n');

  const metricsPort = freePort();
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apps: [
        {
          name: 'h11app',
          script: scriptPath,
          instances: INSTANCES,
          cwd: root,
          healthCheck: { enabled: false },
          metrics: { enabled: true, httpPort: metricsPort },
        },
      ],
    }),
  );

  const observed: string[] = [];

  // -- Generation 0 ---------------------------------------------------------
  let daemonPid = startDaemon('daemon0.log');
  expect(await pollUntil(() => readPid() === daemonPid, 10_000)).toBe(true);
  expect(await pollUntil(() => workerPids().length >= INSTANCES, 5_000)).toBe(true);
  observed.push(`boot#0 workers=${workerPids().length}`);
  expect(workerPids().length).toBe(INSTANCES);

  // -- Crash / restart cycles ------------------------------------------------
  for (let cycle = 1; cycle <= 2; cycle++) {
    const victim = daemonPid;
    process.kill(victim, 'SIGKILL');
    expect(await pollUntil(() => !isAlive(victim), 5_000)).toBe(true);
    await sleep(300);

    // Precondition for the bug: the previous generation survives the crash.
    const orphans = workerPids().length;
    observed.push(`after SIGKILL#${cycle} orphans=${orphans}`);
    expect(orphans).toBe(INSTANCES);

    daemonPid = startDaemon(`daemon${cycle}.log`);
    expect(await pollUntil(() => readPid() === daemonPid, 10_000)).toBe(true);
    await sleep(400);

    const total = workerPids().length;
    observed.push(`boot#${cycle} workers=${total}`);

    // INVARIANT: restore converges to desired state — exactly `instances`
    // worker processes for the app, no matter how many boots preceded it.
    expect({ cycle, workers: total, trace: observed.join(' | ') }).toEqual({
      cycle,
      workers: INSTANCES,
      trace: observed.join(' | '),
    });
  }
}, 25_000);
