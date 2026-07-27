// ---------------------------------------------------------------------------
// H32 – Failed start of an already-running app must not clobber desired state
// ---------------------------------------------------------------------------
//
// Invariant (AGENTS.md): "Persistence reflects successful lifecycle
// transitions. Failed starts/restarts remain retryable and must not leave
// stale desired state."
//
// Concretely: after a `start` request that FAILS, the persisted
// (status, config_json, config_path) triple for that app must be identical to
// what it was immediately before the attempt.
//
// This drives the REAL daemon (src/daemon/boot.ts -> bootDaemon) in a
// subprocess with BUNPILOT_HOME pointed at a private temp dir, talks to it over
// the real unix control socket with the real ControlClient, and inspects the
// real SqliteStore rows.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ControlClient } from '../../src/control/client';
import { SqliteStore } from '../../src/store/sqlite';
import { makeTempDir } from '../_helpers/tmp';

// -- deterministic PRNG (mulberry32) ----------------------------------------
const SEED = 0x5f3a_11c7;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b_79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const REPO = resolve(import.meta.dir, '../..');
const APP = 'h32api';

// -- private sandbox ---------------------------------------------------------
// Short base path: unix socket paths are limited to ~104 bytes on macOS.
const HOME = makeTempDir('bph32-');
const SOCKET = `${HOME}/s.sock`;
const CONFIG_PATH = `${HOME}/bunpilot.config.ts`;
const GOOD_SCRIPT = `${HOME}/good.ts`;
// The daemon co-locates its desired-state store beside its (custom) pid file,
// keyed on the pid file's stem, so two daemons sharing a home never collide on
// one store (h40). This daemon uses pidFile `d.pid`, so its store is `d.db`.
const DB_PATH = `${HOME}/d.db`;

const METRICS_PORT = 20_000 + Math.floor(Math.random() * 20_000);

let daemon: ReturnType<typeof Bun.spawn> | null = null;
let store: SqliteStore | null = null;

afterAll(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  try {
    daemon?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function appConfig(script: string): Record<string, unknown> {
  return {
    name: APP,
    script,
    instances: 1,
    minUptime: 0,
    healthCheck: { enabled: false },
    // Must match the daemon metrics port, otherwise
    // assertAppCompatibleWithDaemon rejects before we reach the store.
    metrics: { enabled: true, httpPort: METRICS_PORT },
  };
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await pred()) return true;
    } catch {
      /* keep polling */
    }
    await Bun.sleep(100);
  }
  return false;
}

test('failed start of an already-running app must not clobber persisted desired state', async () => {
  // -- worker script: stays alive, does nothing ------------------------------
  writeFileSync(GOOD_SCRIPT, 'setInterval(() => {}, 1000);\n');

  // -- daemon config: one app, started at boot -------------------------------
  writeFileSync(
    CONFIG_PATH,
    `export default ${JSON.stringify(
      {
        daemon: { socketFile: SOCKET, pidFile: `${HOME}/d.pid` },
        apps: [appConfig(GOOD_SCRIPT)],
      },
      null,
      2,
    )};\n`,
  );

  // -- daemon entry: calls the real bootDaemon -------------------------------
  const entry = `${HOME}/entry.ts`;
  writeFileSync(
    entry,
    `import { bootDaemon } from ${JSON.stringify(`${REPO}/src/daemon/boot.ts`)};\n` +
      `await bootDaemon(${JSON.stringify(CONFIG_PATH)});\n`,
  );

  daemon = Bun.spawn(['bun', entry], {
    cwd: HOME,
    env: { ...process.env, BUNPILOT_HOME: HOME, BUNPILOT_SOCKET: SOCKET },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const client = new ControlClient(SOCKET);

  const up = await waitFor(async () => {
    if (!existsSync(SOCKET)) return false;
    const res = await client.send('list');
    return res.ok === true;
  }, 12_000);
  expect(up).toBe(true);

  // -- the app must actually be up and persisted as running ------------------
  const running = await waitFor(() => {
    if (!existsSync(DB_PATH)) return false;
    const s = new SqliteStore(DB_PATH);
    try {
      return s.getApp(APP)?.status === 'running';
    } finally {
      s.close();
    }
  }, 8_000);
  expect(running).toBe(true);

  store = new SqliteStore(DB_PATH);

  const before = store.getApp(APP);
  expect(before).not.toBeNull();
  const baseline = {
    status: before!.status,
    config_json: before!.config_json,
    config_path: before!.config_path,
  };
  expect(baseline.status).toBe('running');

  // -- property loop: N failing start attempts, invariant checked each time --
  const rand = mulberry32(SEED);
  const ATTEMPTS = 6;

  for (let i = 0; i < ATTEMPTS; i++) {
    // A *different*, never-validated config each time (what a re-run of
    // `bunpilot start ./bunpilot.config.ts` after an edit would send).
    const badScript = `${HOME}/bad-${Math.floor(rand() * 1e9)}.ts`;
    writeFileSync(badScript, 'setInterval(() => {}, 1000);\n');
    const incoming = appConfig(badScript);

    const res = await client.send('start', { name: APP, config: incoming });

    // The start MUST fail – the app is already running.
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('already running');

    // The app is untouched and still live in the daemon.
    const live = await client.send('list');
    expect(live.ok).toBe(true);
    expect(JSON.stringify(live.data)).toContain(APP);

    // INVARIANT: persisted desired state is byte-identical to the baseline.
    const after = store.getApp(APP);
    const seedMsg = `seed=0x${SEED.toString(16)} attempt=${i}`;

    expect(`${seedMsg} status=${after?.status}`).toBe(`${seedMsg} status=${baseline.status}`);
    expect(JSON.parse(after!.config_json).script).toBe(GOOD_SCRIPT);
    expect(after!.config_path).toBe(baseline.config_path);

    // The exact predicate the boot-time restore loop uses (boot.ts:209):
    // the app must still be picked up on the next daemon boot.
    const restorable = store
      .listApps()
      .filter((r) => r.status === 'running')
      .map((r) => r.name);
    expect(restorable).toContain(APP);
  }
}, 25_000);
