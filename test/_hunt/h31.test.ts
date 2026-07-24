// ---------------------------------------------------------------------------
// h31 – SqliteStore.close() must leave a self-contained database file
//
// Invariant: after store.close(), ~/.bunpilot/bunpilot.db is on its own a
// complete snapshot of desired state. Copying that single file (backup, rsync,
// cp) and opening the copy must reproduce every app / worker / restart row.
//
// Today every method does `this.db.prepare(...)` and drops the Statement
// without `.finalize()`, so Bun's soft `db.close()` defers forever: the native
// connection never closes, the shutdown checkpoint never runs, all data stays
// in bunpilot.db-wal and the main file is left a 4096-byte header-only husk.
// ---------------------------------------------------------------------------

import { Database } from 'bun:sqlite';
import { afterAll, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../src/config/types';
import { SqliteStore } from '../../src/store/sqlite';

// --- deterministic PRNG ----------------------------------------------------
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

function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'test-app',
    script: './index.ts',
    instances: 1,
    maxRestarts: 10,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    backoff: { initial: 100, multiplier: 2, max: 30_000 },
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 10_000,
    ...overrides,
  };
}

const roots: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync('/private/tmp/h31-');
  roots.push(d);
  return d;
}

afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const STATUSES = ['running', 'stopped', 'errored'] as const;

// ---------------------------------------------------------------------------
// Property: for any operation sequence, the file left behind by close() is a
// standalone, complete snapshot.
// ---------------------------------------------------------------------------
test('close() leaves bunpilot.db a self-contained snapshot of desired state', () => {
  const seeds = [1, 7, 42, 1337, 90210];

  for (const seed of seeds) {
    const rnd = mulberry32(seed);
    const root = tempRoot();
    const dbPath = join(root, 'state', 'bunpilot.db');

    // expected desired state, mirrored in memory
    const expected = new Map<string, { status: string; script: string }>();

    const store = new SqliteStore(dbPath);
    try {
      const opCount = 40 + Math.floor(rnd() * 40);
      for (let i = 0; i < opCount; i++) {
        const name = `app-${Math.floor(rnd() * 12)}`;
        const roll = rnd();

        if (roll < 0.45) {
          const script = `./svc-${Math.floor(rnd() * 1000)}.ts`;
          store.saveApp(name, makeAppConfig({ name, script }), join(root, `${name}.json`));
          const prev = expected.get(name);
          expected.set(name, { status: prev?.status ?? 'stopped', script });
        } else if (roll < 0.65) {
          if (expected.has(name)) {
            const status = STATUSES[Math.floor(rnd() * STATUSES.length)]!;
            store.updateAppStatus(name, status);
            expected.get(name)!.status = status;
          }
        } else if (roll < 0.8) {
          store.saveWorker(name, Math.floor(rnd() * 4), 'running', 1000 + i);
        } else if (roll < 0.92) {
          store.addRestartEntry(name, 0, 2000 + i, 1, null, 5_000, 'crash');
        } else {
          store.deleteApp(name);
          expected.delete(name);
        }
      }
    } finally {
      store.close();
    }

    // --- the user backs up the single obvious state file --------------------
    const backupDir = join(root, 'backup');
    mkdirSync(backupDir, { recursive: true });
    const backup = join(backupDir, 'bunpilot.db');
    copyFileSync(dbPath, backup);

    const size = statSync(dbPath).size;

    let rows: Array<{ name: string; config_json: string; status: string }> = [];
    let openError: unknown = null;
    let copy: Database | null = null;
    try {
      copy = new Database(backup);
      rows = copy
        .prepare('SELECT name, config_json, status FROM apps ORDER BY name')
        .all() as typeof rows;
    } catch (err) {
      openError = err;
    } finally {
      copy?.close(false);
    }

    expect(
      `seed=${seed} mainFileSize=${size} openError=${openError ? String(openError) : 'none'}`,
    ).toBe(`seed=${seed} mainFileSize=${size} openError=none`);

    const actual = new Map(rows.map((r) => [r.name, r.status]));
    expect({ seed, apps: [...actual.keys()].sort() }).toEqual({
      seed,
      apps: [...expected.keys()].sort(),
    });

    for (const [name, want] of expected) {
      expect({ seed, name, status: actual.get(name) }).toEqual({
        seed,
        name,
        status: want.status,
      });
      const row = rows.find((r) => r.name === name)!;
      expect({ seed, name, script: JSON.parse(row.config_json).script }).toEqual({
        seed,
        name,
        script: want.script,
      });
    }

    // a header-only husk is exactly one page; real content is far larger
    expect({ seed, husk: size <= 4096 }).toEqual({ seed, husk: false });
  }
}, 20_000);
