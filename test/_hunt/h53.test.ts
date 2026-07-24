import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateApp } from '../../src/config/validator';
import { LogManager } from '../../src/logs/manager';

// CFG-004: for every app, the resolved stdout/stderr paths must be distinct
// across all (workerId, stream) pairs -- including pairs where one side is a
// custom filename and the other uses the default
// `${appName}-${workerId}-out.log` / `-err.log` scheme.

const TMP_ROOT = mkdtempSync(join('/private/tmp', 'bunpilot-h53-'));

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/** Deterministic PRNG (mulberry32). */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = ['svc', 'api', 'worker', 'a', 'my-app'];

test('CFG-004: a custom filename must not be allowed to collide with another worker default log name', () => {
  const failures: string[] = [];

  for (let seed = 1; seed <= 400; seed++) {
    const rnd = makeRng(seed);
    const name = NAMES[Math.floor(rnd() * NAMES.length)] as string;
    const instances = 2 + Math.floor(rnd() * 4); // 2..5
    const victim = 1 + Math.floor(rnd() * (instances - 1)); // 1..instances-1
    const customOnOut = rnd() < 0.5;

    // Case A: custom outFile is byte-identical to the DEFAULT stderr filename of
    //         worker `victim`. Worker 0 stdout -> that path (workerId 0 gets no
    //         suffix); worker `victim` stderr -> same path. Cross-worker collision.
    // Case B: mirror image via errFile vs the default stdout filename.
    const logs = customOnOut
      ? { outFile: `${name}-${victim}-err.log`, maxSize: 1024, maxFiles: 3 }
      : { errFile: `${name}-${victim}-out.log`, maxSize: 1024, maxFiles: 3 };

    const raw = { name, script: 'x.ts', instances, logs };

    let threw = false;
    try {
      validateApp(raw);
    } catch {
      threw = true;
    }

    if (!threw) {
      failures.push(
        `seed=${seed} accepted colliding config: ${JSON.stringify(raw)} ` +
          `(worker 0 ${customOnOut ? 'stdout' : 'stderr'} and worker ${victim} ` +
          `${customOnOut ? 'stderr' : 'stdout'} both resolve to "${
            customOnOut ? logs.outFile : logs.errFile
          }")`,
      );
    }
  }

  if (failures.length > 0) {
    // Print the first failing seeds for reproduction.
    for (const f of failures.slice(0, 3)) console.error(f);
  }

  expect(failures.slice(0, 3)).toEqual([]);
});

test('CFG-004 consequence: an ACCEPTED config must not make two workers share one log file', async () => {
  // Only configs the validator accepts are exercised: if validateApp rejects the
  // colliding config (the fix), nothing reaches LogManager and there is no
  // shared file. Today it is accepted, and two workers land in one file.
  const raw = {
    name: 'svc',
    script: 'x.ts',
    instances: 2,
    logs: { outFile: 'svc-1-err.log', maxSize: 1024, maxFiles: 3 },
  };

  let accepted: ReturnType<typeof validateApp> | null = null;
  try {
    accepted = validateApp(raw);
  } catch {
    accepted = null; // rejected up front — invariant held
  }
  if (accepted === null) return;

  const base = join(TMP_ROOT, 'logs');
  const manager = new LogManager(base);
  try {
    const w0 = manager.createWriters(accepted.name, 0, accepted.logs);
    const w1 = manager.createWriters(accepted.name, 1, accepted.logs);

    await w0.stdout.write('W0-STDOUT\n');
    await w1.stderr.write('W1-STDERR\n');

    const appDir = join(base, accepted.name);
    const files = readdirSync(appDir).sort();
    const mixed = files.filter((f) => {
      const body = readFileSync(join(appDir, f), 'utf8');
      return body.includes('W0-STDOUT') && body.includes('W1-STDERR');
    });

    expect({ files, mixed }).toEqual({ files, mixed: [] });
  } finally {
    await manager.closeAll();
  }
});
