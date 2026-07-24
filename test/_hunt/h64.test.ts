import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateApp } from '../../src/config/validator';
import { LogWriter, rotatedLogPath } from '../../src/logs/writer';

// CFG-006: no configured (or worker-suffixed) log path may equal any rotated
// form `name.N.log` (N in 1..maxFiles) of another configured log path, because
// LogWriter.rotate() renames over the destination with no existence guard.

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join('/private/tmp', 'h64-'));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  void tmpdir;
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

const BASES = ['app.log', 'svc.log', 'out.log', 'nested/app.log', 'plain', 'a.b.log'];

// ---------------------------------------------------------------------------
// 1. Ground truth: rotation really does destroy the other stream's live file.
//    (Documents current writer behaviour; the config layer is the only place
//    this is catchable, per the `name.N.log` rotation contract in AGENTS.md.)
// ---------------------------------------------------------------------------

test('h64: rotation of one stream renames over the other stream live log file', async () => {
  const dir = makeDir();
  const stdoutPath = join(dir, 'app.1.log'); // == rotatedLogPath('app.log', 1)
  const stderrPath = join(dir, 'app.log');

  expect(rotatedLogPath(stderrPath, 1)).toBe(stdoutPath);

  const out = new LogWriter(stdoutPath, 1024, 5);
  const err = new LogWriter(stderrPath, 1024, 5);
  try {
    await out.write('STDOUT-IMPORTANT\n');
    expect(readFileSync(stdoutPath, 'utf8')).toContain('STDOUT-IMPORTANT');

    await err.write(`${'E'.repeat(2000)}\n`); // overflows maxSize -> rotate()

    // The stdout log has been clobbered by stderr's rotation.
    const after = readFileSync(stdoutPath, 'utf8');
    expect(after).not.toContain('STDOUT-IMPORTANT');
    expect(after.startsWith('E')).toBe(true);
  } finally {
    out.close();
    err.close();
  }
});

// ---------------------------------------------------------------------------
// 2. The invariant: validateApp must reject such configs.
// ---------------------------------------------------------------------------

test('h64: validateApp rejects an outFile that is a rotated form of errFile', () => {
  expect(() =>
    validateApp({
      name: 'svc',
      script: 'x.ts',
      instances: 1,
      logs: { outFile: 'app.1.log', errFile: 'app.log', maxSize: 1024, maxFiles: 5 },
    }),
  ).toThrow(/collide/);
});

test('h64: property — rotated-name collisions are always rejected', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const rng = makeRng(seed);
    const base = BASES[Math.floor(rng() * BASES.length)] as string;
    const maxFiles = 1 + Math.floor(rng() * 8);
    const index = 1 + Math.floor(rng() * maxFiles); // within the rotation window
    const victim = rotatedLogPath(base, index);
    const swap = rng() < 0.5;

    const logs = {
      outFile: swap ? base : victim,
      errFile: swap ? victim : base,
      maxSize: 1024,
      maxFiles,
    };

    // Sanity: the two names are distinct, so this is *not* the plain
    // same-filename case the validator already handles.
    expect(logs.outFile).not.toBe(logs.errFile);

    let threw = false;
    try {
      validateApp({ name: 'svc', script: 'x.ts', instances: 1, logs });
    } catch {
      threw = true;
    }

    if (!threw) {
      throw new Error(
        `CFG-006 violated (seed=${seed}): accepted outFile=${logs.outFile} errFile=${logs.errFile} ` +
          `maxFiles=${maxFiles}; rotation of "${base}" renames over "${victim}".`,
      );
    }
  }
});

test('h64: property — non-colliding log pairs stay accepted (no over-rejection)', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const rng = makeRng(seed ^ 0x5f5f);
    const maxFiles = 1 + Math.floor(rng() * 8);
    // A rotated index beyond the rotation window is never produced by rotate().
    const index = maxFiles + 1 + Math.floor(rng() * 5);
    const logs = {
      outFile: rotatedLogPath('app.log', index),
      errFile: 'app.log',
      maxSize: 1024,
      maxFiles,
    };
    expect(() => validateApp({ name: 'svc', script: 'x.ts', instances: 1, logs })).not.toThrow();
  }
});
