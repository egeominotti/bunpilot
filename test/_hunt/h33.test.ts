// h33 — logs.outFile values that normalize to "." resolve to the app log dir
// itself. LogWriter then chmods that DIRECTORY to 0600, permanently breaking
// logging for the app (even the default-named stderr file).

import { expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateLogs } from '../../src/config/validate-helpers';
import { LogManager } from '../../src/logs/manager';

// --- seeded deterministic PRNG (mulberry32) --------------------------------
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

/** Build a relative path string that always resolves back to "." */
function genSelfCancellingPath(rng: () => number): string {
  const segments = ['a', 'b', 'logs', 'x1', 'deep'];
  const depth = 1 + Math.floor(rng() * 3); // 1..3
  const parts: string[] = [];
  if (rng() < 0.5) parts.push('.');
  for (let i = 0; i < depth; i++) {
    parts.push(segments[Math.floor(rng() * segments.length)] as string);
    if (rng() < 0.4) parts.push('.');
  }
  for (let i = 0; i < depth; i++) parts.push('..');
  return parts.join('/');
}

test('validateLogs rejects outFile/errFile that resolve to the app log dir itself', () => {
  const rng = makeRng(0xc0ffee);
  const cases: string[] = ['.', './', 'a/..', './a/..', 'a/b/../..'];
  for (let i = 0; i < 200; i++) cases.push(genSelfCancellingPath(rng));

  for (const candidate of cases) {
    // sanity: these are the *inputs* under test — Bun's path resolves them to "."
    for (const field of ['outFile', 'errFile'] as const) {
      let threw = false;
      try {
        validateLogs({ [field]: candidate, maxSize: 1024, maxFiles: 5 }, 'ctx');
      } catch {
        threw = true;
      }
      expect(
        threw,
        `seed=0xc0ffee logs.${field}=${JSON.stringify(candidate)} was accepted but ` +
          `join(appDir, it) === appDir (the log directory, not a file)`,
      ).toBe(true);
    }
  }
});

test('createWriters never turns the app log directory into the log file', async () => {
  const base = mkdtempSync(join('/private/tmp', 'h33-logs-'));
  const appDir = join(base, 'svc');
  try {
    const mgr = new LogManager(base);

    // Rejecting the config outright is a perfectly good fix — if validateLogs
    // throws, the dangerous value never reaches LogManager and we are done.
    let config: ReturnType<typeof validateLogs>;
    try {
      config = validateLogs({ outFile: '.', maxSize: 1024, maxFiles: 5 }, 'ctx');
    } catch {
      return;
    }

    let writers: { stdout: unknown; stderr: unknown } | undefined;
    try {
      writers = mgr.createWriters('svc', 0, config) as never;
    } catch {
      // A throw here is also an acceptable (safe) outcome; the invariant below
      // still has to hold.
    }

    if (existsSync(appDir)) {
      const mode = statSync(appDir).mode & 0o777;
      expect(
        mode,
        `app log directory ${appDir} was chmod'ed to ${mode.toString(8)} — LogWriter ` +
          `treated the directory as its log file, stripping the execute bit`,
      ).toBe(0o700);
    }

    // And the *stderr* writer (plain default filename) must still be writable.
    if (writers) {
      const stderrWriter = writers.stderr as { write(d: string): Promise<void> };
      await stderrWriter.write('hello\n');
      expect(existsSync(join(appDir, 'svc-0-err.log'))).toBe(true);
    }
  } finally {
    try {
      if (existsSync(appDir)) chmodSync(appDir, 0o700);
    } catch {
      /* best effort */
    }
    rmSync(base, { recursive: true, force: true });
  }
});
