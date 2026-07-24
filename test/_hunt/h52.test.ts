// ---------------------------------------------------------------------------
// H52 — DMN-05: bootDaemon must release every resource it acquired on every
//               exit path, including the failure path.
// ---------------------------------------------------------------------------
//
// src/daemon/boot.ts acquires, in order:
//
//   :59   const store = new SqliteStore();            // opens bunpilot.db (+ -wal/-shm)
//   :199  await controlServer.start();                // binds & chmods the unix socket
//   :203  metricsServer.start();                      // Bun.serve() — throws on EADDRINUSE
//
// There is no try/finally spanning those three, and `cleanup` (:166) is only
// wired to `master.onShutdown`, i.e. it is reachable exclusively through
// master.shutdown(). So when the metrics listener cannot bind its port the
// exception propagates straight out of bootDaemon and the already-bound
// control socket is never stopped and its socket file is never unlinked
// (ControlServer.removeOwnedSocket is private and only called from stop()).
//
// This test drives the REAL bootDaemon inside an isolated BUNPILOT_HOME in a
// child process, with the daemon's metrics port already occupied by another
// listener, and asserts the post-conditions of the failure path.
//
// Property-based: a seeded PRNG generates several independent boot attempts
// (different app sets, different socket paths, different ephemeral ports) and
// the invariant is asserted after every one of them.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const TMP_BASE = '/private/tmp';

const tmpRoot = mkdtempSync(join(TMP_BASE, 'bunpilot-h52-'));
let child: ReturnType<typeof Bun.spawn> | null = null;

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

// -- seeded PRNG ------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ask the OS for a currently-free TCP port on the loopback interface. */
function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

// -- driver executed inside the isolated child process ----------------------

const DRIVER_SOURCE = `
const ROOT = process.env.H52_ROOT;
const PLAN = JSON.parse(process.env.H52_PLAN);

const { existsSync, unlinkSync } = await import('node:fs');
const { bootDaemon } = await import(ROOT + '/src/daemon/boot.ts');

/** Is something actually accepting connections on this unix socket path? */
function socketReachable(path) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } };
    const t = setTimeout(() => done(true), 500);
    Bun.connect({
      unix: path,
      socket: {
        open(s) { done(true); s.end(); },
        data() {},
        close() { done(false); },
        error() { done(false); },
      },
    }).catch(() => done(false));
  });
}

/** Ask a live daemon to shut itself down (used only if a boot SUCCEEDS). */
function killDaemon(path) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 3000);
    Bun.connect({
      unix: path,
      socket: {
        open(s) { s.write(JSON.stringify({ id: 'k', cmd: 'kill-daemon', args: {} }) + '\\n'); },
        data() { clearTimeout(t); resolve(); },
        close() { clearTimeout(t); resolve(); },
        error() { clearTimeout(t); resolve(); },
      },
    }).catch(() => { clearTimeout(t); resolve(); });
  });
}

const observations = [];
let liveSocket = null;
try {
  for (const step of PLAN) {
    // Somebody else already owns the port the daemon wants for /metrics.
    // This is the whole scenario: an *optional* subsystem cannot bind.
    const hog = Bun.serve({
      hostname: '127.0.0.1',
      port: step.metricsPort,
      fetch: () => new Response('occupied'),
    });

    let bootError = null;
    try {
      await bootDaemon(step.configPath);
    } catch (err) {
      bootError = String(err && err.message ? err.message : err);
    }

    const obs = {
      step,
      bootError,
      socketFileExists: existsSync(step.socketFile),
      socketStillListening: await socketReachable(step.socketFile),
    };
    observations.push(obs);

    try { hog.stop(true); } catch {}

    if (bootError === null) {
      // bootDaemon survived the port collision: a real daemon (with real
      // workers) is now live in this process. Stop iterating and shut it down.
      liveSocket = step.socketFile;
      break;
    }

    // Teardown for the next iteration (the daemon under test did none of it).
    try { if (existsSync(step.socketFile)) unlinkSync(step.socketFile); } catch {}
  }
} catch (err) {
  console.log('H52_FATAL:' + JSON.stringify(String(err && err.stack ? err.stack : err)));
} finally {
  console.log('H52_RESULT:' + JSON.stringify(observations));
  if (liveSocket) {
    killDaemon(liveSocket).then(() => setTimeout(() => process.exit(0), 2000));
    setTimeout(() => process.exit(0), 8000);
  } else {
    process.exit(0);
  }
}
`;

// ---------------------------------------------------------------------------

interface Step {
  iteration: number;
  metricsPort: number;
  socketFile: string;
  configPath: string;
  appNames: string[];
}

interface Observation {
  step: Step;
  bootError: string | null;
  socketFileExists: boolean;
  socketStillListening: boolean;
}

test('DMN-05: a failed metrics bind must not leak the control socket', async () => {
  const seed = 52_20260723;
  const rand = mulberry32(seed);

  const workerPath = join(tmpRoot, 'worker.js');
  writeFileSync(workerPath, 'setInterval(() => {}, 1000);\n');

  const iterations = 3;
  const plan: Step[] = [];

  for (let i = 0; i < iterations; i++) {
    const metricsPort = freePort();
    const appCount = 1 + Math.floor(rand() * 3); // 1..3 apps
    const appNames: string[] = [];
    for (let a = 0; a < appCount; a++) {
      appNames.push(`app${Math.floor(rand() * 1_000_000).toString(36)}${i}${a}`);
    }

    const socketFile = join(tmpRoot, `ctl-${i}.sock`);
    const pidFile = join(tmpRoot, `bunpilot-${i}.pid`);
    const configPath = join(tmpRoot, `bunpilot-${i}.json`);

    writeFileSync(
      configPath,
      JSON.stringify(
        {
          apps: appNames.map((name) => ({
            name,
            script: workerPath,
            instances: 1,
            minUptime: 100,
            metrics: {
              enabled: true,
              httpPort: metricsPort,
              prometheus: false,
              collectInterval: 5000,
            },
          })),
          daemon: { socketFile, pidFile },
        },
        null,
        2,
      ),
    );

    plan.push({ iteration: i, metricsPort, socketFile, configPath, appNames });
  }

  const home = join(tmpRoot, 'home');
  const driverPath = join(tmpRoot, 'driver.ts');
  writeFileSync(driverPath, DRIVER_SOURCE);

  child = Bun.spawn(['bun', 'run', driverPath], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      BUNPILOT_HOME: home,
      H52_ROOT: REPO_ROOT,
      H52_PLAN: JSON.stringify(plan),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const killer = setTimeout(() => {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 15_000);

  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  clearTimeout(killer);

  const fatal = stdout.split('\n').find((l) => l.startsWith('H52_FATAL:'));
  const resultLine = stdout.split('\n').find((l) => l.startsWith('H52_RESULT:'));

  if (!resultLine) {
    throw new Error(
      `driver produced no result (seed=${seed})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }

  const observations: Observation[] = JSON.parse(resultLine.slice('H52_RESULT:'.length));

  if (observations.length === 0) {
    throw new Error(
      `driver collected no observations (seed=${seed})\n` +
        `fatal=${fatal ?? 'none'}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }

  const ctx = (obs: Observation) =>
    `seed=${seed} iter=${obs.step.iteration} apps=[${obs.step.appNames.join(',')}] ` +
    `metricsPort=${obs.step.metricsPort} socket=${obs.step.socketFile} ` +
    `bootError=${JSON.stringify(obs.bootError)}`;

  // Sanity: whenever the boot DID fail, it failed for the reason under test
  // (the metrics listener could not bind its port), not for some unrelated
  // setup mistake in this test.
  for (const obs of observations) {
    if (obs.bootError === null) continue;
    expect(
      `${ctx(obs)} :: mentionsPort=${obs.bootError.includes(String(obs.step.metricsPort))}`,
    ).toBe(`${ctx(obs)} :: mentionsPort=true`);
  }

  // INVARIANT (DMN-05): every resource bootDaemon acquires is released on every
  // exit path. Concretely, the control socket is live if and only if the boot
  // succeeded:
  //
  //   - boot resolved  -> the daemon is up, socket bound and file on disk;
  //   - boot rejected  -> nothing bound, nothing left on disk, so the next
  //                       `bunpilot list` says "daemon is not running" instead
  //                       of "Failed to connect" to a half-dead daemon.
  //
  // Both plausible fixes satisfy this: either the metrics listener stops being
  // an unconditional boot dependency, or the boot failure path runs cleanup().
  for (const obs of observations) {
    const booted = obs.bootError === null;
    expect(
      `${ctx(obs)} :: listening=${obs.socketStillListening} file=${obs.socketFileExists}`,
    ).toBe(`${ctx(obs)} :: listening=${booted} file=${booted}`);
  }
}, 25_000);
