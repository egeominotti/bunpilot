import { test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { validateApp } from '../../src/config/validator';
import { LogManager } from '../../src/logs/manager';

// Deterministic PRNG (mulberry32) so a failure is reproducible from its seed.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEGMENTS = ['.', '..', 'a', 'b', 'sub'];

function genCandidate(rnd: () => number): string {
  const count = 1 + Math.floor(rnd() * 3);
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(SEGMENTS[Math.floor(rnd() * SEGMENTS.length)] as string);
  }
  let s = parts.join('/');
  if (rnd() < 0.3) s += '/';
  return s;
}

/**
 * CFG-008: a log filename accepted by config validation must resolve to a path
 * STRICTLY BELOW the app log directory — never to the app log directory itself.
 *
 * LogWriter's constructor does `chmodSync(filePath, 0o600)` when the path already
 * exists. If the validated filename resolves to the app log dir, that call strips
 * the directory's execute bit and permanently breaks every writer for that app.
 */
test('CFG-008: validated logs.outFile never resolves to the app log directory itself', () => {
  const base = mkdtempSync(join('/private/tmp', 'h21-cfg-'));
  const appDir = join(base, 'svc');
  const appDirAbs = resolve(appDir);

  // Seed 0 is the hand-picked witness; the rest is randomized exploration.
  const candidates: Array<{ seed: number; value: string }> = [
    { seed: -1, value: '.' },
    { seed: -2, value: './' },
    { seed: -3, value: 'a/..' },
    { seed: -4, value: 'a/../' },
  ];
  for (let seed = 1; seed <= 300; seed++) {
    candidates.push({ seed, value: genCandidate(prng(seed)) });
  }

  try {
    for (const { seed, value } of candidates) {
      let accepted = false;
      try {
        validateApp({ name: 'svc', script: 'x.ts', logs: { outFile: value } });
        accepted = true;
      } catch {
        // Rejected by validation — nothing can escape, invariant holds vacuously.
      }
      if (!accepted) continue;

      const resolved = resolve(join(appDir, value));

      // The accepted filename must land strictly inside the app dir.
      if (resolved === appDirAbs || !resolved.startsWith(appDirAbs + sep)) {
        throw new Error(
          `CFG-008 violated (seed=${seed}): logs.outFile=${JSON.stringify(value)} was accepted ` +
            `by validateApp but resolves to ${resolved} which is not a regular file below ${appDirAbs}`,
        );
      }
    }
  } finally {
    if (existsSync(appDir)) chmodSync(appDir, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

/**
 * The consequence: constructing writers from an accepted config must not destroy
 * the app log directory's permissions.
 */
test('CFG-008: accepted logs config never strips the app log dir execute bit', async () => {
  const base = mkdtempSync(join('/private/tmp', 'h21-mgr-'));
  const appDir = join(base, 'svc');

  try {
    for (const value of ['.', './', 'a/..']) {
      let app: ReturnType<typeof validateApp>;
      try {
        app = validateApp({ name: 'svc', script: 'x.ts', logs: { outFile: value } });
      } catch {
        continue; // properly rejected
      }

      const mgr = new LogManager(base);
      let writers: { stdout: unknown; stderr: unknown } | undefined;
      try {
        writers = mgr.createWriters('svc', 0, app.logs);
      } catch {
        // A throw here is an acceptable (loud) outcome; the silent corruption is not.
      }
      void writers;

      const mode = statSync(appDir).mode & 0o777;
      if ((mode & 0o100) === 0) {
        throw new Error(
          `CFG-008 violated: logs.outFile=${JSON.stringify(value)} was accepted, and creating ` +
            `writers chmod'd the app log dir ${appDir} to 0o${mode.toString(8)} ` +
            `(execute bit gone → all future logging for this app fails with EACCES)`,
        );
      }
      await mgr.closeAll();
    }
  } finally {
    if (existsSync(appDir)) chmodSync(appDir, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

void tmpdir;
