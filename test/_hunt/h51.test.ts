import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateApp } from '../../src/config/validator';
import { LogManager } from '../../src/logs/manager';
import { readLogLines, rotationIndex } from '../../src/logs/reader';
import { rotatedLogPath } from '../../src/logs/writer';

// LOG-1 (AGENTS.md: "Log rotation naming is `name.N.log`"): every custom log
// filename that config validation ACCEPTS must produce files that
// (a) `bunpilot logs` can actually read back, and
// (b) rotate into the reader-parseable `name.N.log` form.
//
// Property: for every generated outFile, either validateApp rejects it, or the
// lines written through the real LogManager/LogWriter are visible to
// readLogLines and the rotated sibling parses as rotation index 1.

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function mkRoot(): string {
  const root = mkdtempSync(join('/private/tmp', 'h51-'));
  roots.push(root);
  return root;
}

/** Seeded deterministic PRNG (mulberry32). */
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

const STEMS = ['server', 'out', 'app-out', 'my.service', 'worker_1'];
const EXTS = ['.log', '.txt', '', '.out', '.LOG', '.log.txt'];

test('LOG-1: any accepted logs.outFile must stay readable and rotate as name.N.log', async () => {
  // Sanity check on the temp dir used by mkdtemp: keep away from ~/.bunpilot.
  expect(tmpdir().length).toBeGreaterThan(0);

  const rand = prng(0xc0ffee);
  const failures: string[] = [];

  for (let iteration = 0; iteration < 60; iteration++) {
    const seed = iteration;
    const stem = STEMS[Math.floor(rand() * STEMS.length)] as string;
    const ext = EXTS[Math.floor(rand() * EXTS.length)] as string;
    const outFile = `${stem}${ext}`;
    const appName = `app${seed}`;

    // 1. Does config validation accept this custom log filename?
    let accepted = true;
    try {
      validateApp({ name: appName, script: 'x.ts', logs: { outFile } });
    } catch {
      accepted = false;
    }
    if (!accepted) continue; // rejecting the name is a valid way to hold LOG-1

    // 2. It was accepted, so the full write -> read round trip must work.
    const root = mkRoot();
    const manager = new LogManager(root);
    try {
      const { stdout } = manager.createWriters(appName, 0, {
        maxSize: 1_048_576,
        maxFiles: 5,
        outFile,
      });
      await stdout.write('hello world\n');

      const lines = readLogLines(root, appName, 50);
      if (lines.length === 0 || lines[lines.length - 1] !== 'hello world') {
        failures.push(
          `seed=${seed} outFile=${JSON.stringify(outFile)}: readLogLines returned ${JSON.stringify(lines)}`,
        );
      }

      // 3. Rotation must land on a reader-parseable `name.N.log` name.
      const rotated = rotatedLogPath(join(root, appName, outFile), 1);
      if (rotationIndex(rotated) !== 1) {
        failures.push(
          `seed=${seed} outFile=${JSON.stringify(outFile)}: rotated name ${JSON.stringify(rotated)} has rotationIndex ${rotationIndex(rotated)} (want 1)`,
        );
      }
    } finally {
      await manager.closeAll();
    }
  }

  if (failures.length > 0) {
    console.error(`LOG-1 violations (${failures.length}):\n  ${failures.join('\n  ')}`);
  }
  expect(failures).toEqual([]);
});
