// ---------------------------------------------------------------------------
// h40 – Two daemons with distinct daemon.{pidFile,socketFile,logFile} must own
// distinct desired state.
//
// `resolveDaemonPaths()` deliberately lets a config move the pid/socket/log
// files, so two daemons booted from two different configs are expected to
// coexist. `bootDaemon()` however opens the desired-state store with
// `new SqliteStore()` – i.e. always the process-global DB_PATH – so the second
// daemon reads the first daemon's rows on boot and adopts its apps.
//
// Invariant: a live daemon must only run the apps it owns.
// ---------------------------------------------------------------------------

import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ControlClient } from '../../src/control/client';
import { killMatching } from '../_helpers/procs';
import { makeTempDir } from '../_helpers/tmp';

const SEED = 0x4_0_40;

const repo = join(import.meta.dir, '../..');
const tmp = makeTempDir('bunpilot-h40-');
const home = join(tmp, 'home');
mkdirSync(home, { recursive: true });

const scriptPath = join(tmp, 'worker.ts');
const aConfigPath = join(tmp, 'a.config.ts');
const bConfigPath = join(tmp, 'b.config.ts');
const aPid = join(tmp, 'a.pid');
const bPid = join(tmp, 'b.pid');
const aSock = join(tmp, 'a.sock');
const bSock = join(tmp, 'b.sock');
const dbPath = join(home, 'bunpilot.db');

const procs: ReturnType<typeof Bun.spawn>[] = [];

afterAll(async () => {
  // Graceful first so the daemons take their workers down with them.
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  await Bun.sleep(500);
  for (const p of procs) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  // Backstop: nothing spawned from this temp dir may survive the test.
  killMatching(tmp);
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic PRNG so the operation order is reproducible from SEED. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function freePort(): Promise<number> {
  return await new Promise<number>((resolveP, rejectP) => {
    const srv = createServer();
    srv.on('error', rejectP);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolveP(port));
    });
  });
}

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function spawnDaemon(configPath: string) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.BUNPILOT_HOME = home;
  delete env.BUNPILOT_SOCKET;
  const proc = Bun.spawn(
    [process.execPath, 'run', join(repo, 'src/index.ts'), '__daemon', configPath],
    { cwd: repo, env, stdout: 'pipe', stderr: 'pipe' },
  );
  procs.push(proc);
  return proc;
}

function writeConfig(
  path: string,
  appName: string,
  metricsPort: number,
  pidFile: string,
  socketFile: string,
  logFile: string,
): void {
  const body = {
    daemon: { pidFile, socketFile, logFile },
    apps: [
      {
        name: appName,
        script: scriptPath,
        instances: 1,
        healthCheck: { enabled: false },
        metrics: { enabled: true, httpPort: metricsPort },
      },
    ],
  };
  writeFileSync(path, `export default ${JSON.stringify(body, null, 2)};\n`);
}

/**
 * Owner recorded for `name` in the shared default store, or null when the row
 * (or the store itself) does not exist – which is the expected shape once each
 * daemon owns its own desired-state store.
 */
function configPathOf(name: string): string | null {
  if (!existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query('SELECT config_path FROM apps WHERE name = ?1').get(name) as {
      config_path: string | null;
    } | null;
    return row ? row.config_path : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('a second daemon must not adopt the first daemon apps', async () => {
  writeFileSync(scriptPath, 'setInterval(() => {}, 1000);\n');

  const portA = await freePort();
  const portB = await freePort();
  writeConfig(aConfigPath, 'alpha-h40', portA, aPid, aSock, join(tmp, 'a.log'));
  writeConfig(bConfigPath, 'beta-h40', portB, bPid, bSock, join(tmp, 'b.log'));

  // -- Daemon A: owns alpha --------------------------------------------------
  spawnDaemon(aConfigPath);
  await waitFor(() => existsSync(aPid), 15000, 'daemon A pid file');

  // -- Daemon B: separate pid/socket/log + separate metrics port -> coexists --
  spawnDaemon(bConfigPath);
  await waitFor(() => existsSync(bPid), 15000, 'daemon B pid file');

  const clientA = new ControlClient(aSock);
  const clientB = new ControlClient(bSock);

  const rand = mulberry32(SEED);
  const ops = ['list', 'status', 'ping'] as const;

  for (let step = 0; step < 4; step++) {
    const op = ops[Math.floor(rand() * ops.length)] ?? 'list';
    if (op === 'status') {
      await clientA.send('status', { name: 'alpha-h40' });
    } else if (op === 'ping') {
      await clientB.send('ping', {});
    }

    const listB = await clientB.send('list', {});
    expect(listB.ok).toBe(true);
    const namesB = ((listB.data as Array<{ name: string }>) ?? []).map((a) => a.name).sort();

    // Daemon B owns exactly the apps in b.config.ts.
    expect({ seed: SEED, step, op, names: namesB }).toEqual({
      seed: SEED,
      step,
      op,
      names: ['beta-h40'],
    });

    // ...and it must not have taken over alpha's ownership record either.
    expect({ seed: SEED, step, alphaOwnedByB: configPathOf('alpha-h40') === bConfigPath }).toEqual({
      seed: SEED,
      step,
      alphaOwnedByB: false,
    });
  }

  // Daemon A still owns alpha.
  const listA = await clientA.send('list', {});
  expect(((listA.data as Array<{ name: string }>) ?? []).map((a) => a.name).sort()).toEqual([
    'alpha-h40',
  ]);
}, 25000);
