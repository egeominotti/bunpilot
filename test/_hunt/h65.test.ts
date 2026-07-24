import { afterAll, expect, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { validateLogs } from '../../src/config/validate-helpers';
import { LogManager } from '../../src/logs/manager';

// ---------------------------------------------------------------------------
// Invariant under test (CFG-008):
//   A `logs.outFile` / `logs.errFile` value accepted by validateLogs() must
//   resolve to a REGULAR FILE strictly below the app log directory — never to
//   the app log directory itself. If it resolves to the directory, LogWriter's
//   constructor runs `chmodSync(filePath, 0o600)` on it, stripping the traverse
//   bit from the app's whole log directory (every existing log becomes
//   unreadable) and every subsequent write throws EISDIR.
// ---------------------------------------------------------------------------

const BASE = mkdtempSync('/private/tmp/h65-');

afterAll(() => {
  // Damaged dirs may be mode 0600 (no traverse) — restore before rm -rf.
  try {
    for (const entry of readdirSync(BASE)) {
      try {
        chmodSync(join(BASE, entry), 0o700);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  rmSync(BASE, { recursive: true, force: true });
});

/** Deterministic 32-bit LCG. */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const SEGMENTS = ['a', 'b', 'logs', 'archive', '.', '..', 'out.log', 'x'];

function generateFilename(rand: () => number): string {
  const n = 1 + Math.floor(rand() * 4);
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const seg = SEGMENTS[Math.floor(rand() * SEGMENTS.length)];
    if (seg !== undefined) parts.push(seg);
  }
  let name = parts.join('/');
  if (rand() < 0.15) name += '/';
  return name;
}

/**
 * Composed check: whatever validateLogs() accepts must be safe to hand to
 * LogManager.createWriters(). Returns the app-dir mode after the round trip.
 */
function roundTrip(
  appName: string,
  filename: string,
): { accepted: boolean; modeBefore: number; modeAfter: number } {
  let accepted = true;
  let config: ReturnType<typeof validateLogs> | undefined;
  try {
    config = validateLogs({ outFile: filename, maxSize: 1024, maxFiles: 5 }, 'app:svc');
  } catch {
    accepted = false;
  }

  const appDir = join(BASE, appName);
  mkdirSync(appDir, { recursive: true, mode: 0o700 });
  // A pre-existing log file that must remain readable.
  writeFileSync(join(appDir, 'pre-existing.log'), 'previous output\n', { mode: 0o600 });
  const modeBefore = statSync(appDir).mode & 0o777;

  if (!accepted || !config) {
    return { accepted, modeBefore, modeAfter: modeBefore };
  }

  const manager = new LogManager(BASE);
  try {
    manager.createWriters(appName, 0, config);
  } catch {
    /* a throw is not the invariant under test; the dir mode is */
  }
  const modeAfter = statSync(appDir).mode & 0o777;
  // Undo any damage so the next iteration / cleanup can traverse.
  chmodSync(appDir, 0o700);
  return { accepted, modeBefore, modeAfter };
}

test('CFG-008: an accepted logs.outFile must not chmod the app log dir to 0600', () => {
  const SEED = 20260723;
  const rand = makePrng(SEED);
  const failures: string[] = [];

  // Deterministic regression cases + generated ones.
  const cases: string[] = ['a/..', '.', './', 'a/b/../..', 'logs/../.', 'out.log', 'archive/o.log'];
  for (let i = 0; i < 250; i++) cases.push(generateFilename(rand));

  let idx = 0;
  for (const filename of cases) {
    idx++;
    if (filename.length === 0) continue;
    const { accepted, modeBefore, modeAfter } = roundTrip(`svc${idx}`, filename);
    if (accepted && modeAfter !== modeBefore) {
      failures.push(
        `seed=${SEED} case#${idx} outFile=${JSON.stringify(filename)}: ` +
          `app log dir mode ${modeBefore.toString(8)} -> ${modeAfter.toString(8)}`,
      );
    }
  }

  expect(failures).toEqual([]);
});
