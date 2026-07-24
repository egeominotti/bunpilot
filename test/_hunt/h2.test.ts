// ---------------------------------------------------------------------------
// H2 – A failed duplicate `start` must not mutate the persisted desired state
//      of an app it never took ownership of.
// ---------------------------------------------------------------------------
//
// Invariant under test:
//   For an app that is RUNNING under the daemon, any `start` request that the
//   daemon rejects (ok:false) must leave the persisted row untouched:
//     status      === 'running'
//     config_path === <path of the config file the daemon booted with>
//
// src/daemon/boot.ts:81-93 violates this: ctx.startApp() unconditionally calls
// store.saveApp(name, config)  (configPath === undefined -> config_path = NULL)
// and then, when master.startApp() throws `App "..." is already running.`,
// the catch block runs store.updateAppStatus(name, 'stopped') on the row of an
// app that is still very much running.
// ---------------------------------------------------------------------------

import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ControlClient } from '../../src/control/client';

// ---------------------------------------------------------------------------
// Deterministic PRNG (seeded) – drives the operation sequence
// ---------------------------------------------------------------------------

const SEED = 0xb2c0ffee;

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

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const tmp = mkdtempSync('/private/tmp/bunpilot-h2-');
const repo = join(import.meta.dir, '..', '..');
const socketPath = join(tmp, 'bunpilot.sock');
const dbPath = join(tmp, 'bunpilot.db');
const configPath = join(tmp, 'eco.config.ts');
const scriptPath = join(tmp, 'app.ts');
const metricsPort = 20000 + Math.floor(Math.random() * 20000);

let proc: ReturnType<typeof Bun.spawn> | null = null;

afterAll(() => {
  try {
    proc?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  rmSync(tmp, { recursive: true, force: true });
});

const APP = {
  name: 'dup',
  script: scriptPath,
  instances: 1,
  healthCheck: { enabled: false },
  metrics: { enabled: true, httpPort: metricsPort },
};

function readRow(): { status: string; config_path: string | null } | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query('SELECT status, config_path FROM apps WHERE name = ?1').get('dup') as {
      status: string;
      config_path: string | null;
    } | null;
  } finally {
    db.close();
  }
}

async function waitFor(pred: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('rejected duplicate start must not corrupt the persisted desired state', async () => {
  writeFileSync(scriptPath, 'setInterval(() => {}, 1000);\n');
  writeFileSync(
    configPath,
    `export default ${JSON.stringify(
      {
        daemon: { socketFile: socketPath, pidFile: join(tmp, 'bunpilot.pid') },
        apps: [APP],
      },
      null,
      2,
    )};\n`,
  );

  proc = Bun.spawn([process.execPath, 'run', join(repo, 'src/index.ts'), '__daemon', configPath], {
    cwd: repo,
    env: { ...process.env, BUNPILOT_HOME: tmp, BUNPILOT_SOCKET: socketPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  await waitFor(() => existsSync(join(tmp, 'bunpilot.pid')), 15000, 'daemon pid file');

  const client = new ControlClient(socketPath);

  // Baseline: the app booted from the config file, so it is running and the
  // row remembers where its config came from.
  const baseline = readRow();
  expect(baseline?.status).toBe('running');
  expect(baseline?.config_path).toBe(configPath);

  const rand = mulberry32(SEED);
  const ops = ['start', 'list', 'status'] as const;

  for (let i = 0; i < 6; i++) {
    // Always exercise a duplicate `start` at least every other step; mix in
    // read-only commands in a seeded order so ordering effects are covered.
    const op = i % 2 === 0 ? 'start' : ops[Math.floor(rand() * ops.length)]!;

    if (op === 'start') {
      const res = await client.send('start', { name: 'dup', config: APP });
      // The daemon must reject it: the app is already owned by an earlier request.
      expect(res.ok).toBe(false);
    } else if (op === 'list') {
      await client.send('list', {});
    } else {
      await client.send('status', { name: 'dup' });
    }

    // The app is still running in the daemon...
    const status = await client.send('status', { name: 'dup' });
    expect(status.ok).toBe(true);

    // ...therefore the persisted desired state must be untouched.
    const row = readRow();
    expect({ seed: SEED, step: i, op, ...row }).toEqual({
      seed: SEED,
      step: i,
      op,
      status: 'running',
      config_path: configPath,
    });
  }
}, 25000);
