// h13 — `bunpilot logs -f` drops lines that are not appended at the very end of
// the concatenated multi-file tail.
//
// INV-CLI-18-FOLLOW-STREAM-CONTINUITY: the lines printed after each poll are
// exactly the lines appended since the previous poll — no duplicates, no gaps.
//
// The daemon tail is NOT a single append-only file: readLogLines() concatenates
// every *.log under <logs>/<app>/ sorted by base name, so `<app>-0-err.log`
// always precedes `<app>-0-out.log`. A new stderr line is therefore INSERTED in
// the middle of the tail, and findNewLogLines() — which only looks for a
// trailing suffix overlap — returns [] and drops it forever.

import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findNewLogLines } from '../../src/cli/commands/logs';
import { readLogLines } from '../../src/logs/reader';

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join('/private/tmp', 'bp-h13-'));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  // never touch ~/.bunpilot; tmpdir() referenced only to keep the import honest
  void tmpdir;
});

// Deterministic PRNG (mulberry32) so failures are reproducible from the seed.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('h13: logs --follow must not drop non-trailing appends', () => {
  test('unit: a line appended to the stderr block is reported as new', () => {
    // previous tail: err block ["E1","E2"] then out block ["O1","O2"]
    // stderr writes "E3" -> it lands between "E2" and "O1"
    expect(findNewLogLines(['E1', 'E2', 'O1', 'O2'], ['E1', 'E2', 'E3', 'O1', 'O2'])).toEqual([
      'E3',
    ]);
  });

  test('integration: a stderr line written against the real reader is not lost', () => {
    const root = makeRoot();
    const appDir = join(root, 'myapp');
    mkdirSync(appDir, { recursive: true });

    const outPath = join(appDir, 'myapp-0-out.log');
    const errPath = join(appDir, 'myapp-0-err.log');
    writeFileSync(outPath, 'O1\nO2\n');
    writeFileSync(errPath, 'E1\n');

    const previous = readLogLines(root, 'myapp', 200);
    // sanity: the reader really does put the err block first
    expect(previous).toEqual(['E1', 'O1', 'O2']);

    appendFileSync(errPath, 'E2-BOOM\n');
    const current = readLogLines(root, 'myapp', 200);
    expect(current).toEqual(['E1', 'E2-BOOM', 'O1', 'O2']);

    expect(findNewLogLines(previous, current)).toEqual(['E2-BOOM']);
  });

  test('property: every appended line is emitted exactly once across a poll sequence', () => {
    const seeds = [1, 2, 3, 7, 11, 42, 1337, 90210];

    for (const seed of seeds) {
      const rng = makeRng(seed);
      const root = makeRoot();
      const appDir = join(root, 'app');
      mkdirSync(appDir, { recursive: true });

      // Two instances x (out, err) — exactly what a clustered app produces.
      const streams = [
        join(appDir, 'app-0-out.log'),
        join(appDir, 'app-0-err.log'),
        join(appDir, 'app-1-out.log'),
        join(appDir, 'app-1-err.log'),
      ];
      for (const path of streams) writeFileSync(path, '');

      // Seed each stream with one line so no block is empty.
      for (let i = 0; i < streams.length; i++) appendFileSync(streams[i], `seed-${i}\n`);

      let snapshot = readLogLines(root, 'app', 200);
      const emitted: string[] = [];
      const written = new Set<string>(snapshot);

      for (let step = 0; step < 25; step++) {
        // One poll interval writes 1..3 lines to randomly chosen streams.
        const count = 1 + Math.floor(rng() * 3);
        const expectedNew: string[] = [];
        for (let n = 0; n < count; n++) {
          const target = Math.floor(rng() * streams.length);
          const line = `s${seed}-step${step}-n${n}-stream${target}`;
          appendFileSync(streams[target], `${line}\n`);
          written.add(line);
          expectedNew.push(line);
        }

        const current = readLogLines(root, 'app', 200);
        const appended = findNewLogLines(snapshot, current);
        emitted.push(...appended);
        snapshot = current;

        for (const line of expectedNew) {
          if (!emitted.includes(line)) {
            throw new Error(
              `seed=${seed} step=${step}: line "${line}" was appended but never emitted by ` +
                `findNewLogLines (gap). appended-this-poll=${JSON.stringify(appended)}`,
            );
          }
        }
      }

      // No duplicates and no gaps overall.
      const counts = new Map<string, number>();
      for (const line of emitted) counts.set(line, (counts.get(line) ?? 0) + 1);
      for (const [line, n] of counts) {
        if (n !== 1) throw new Error(`seed=${seed}: line "${line}" emitted ${n} times (duplicate)`);
      }
      expect(new Set(emitted).size).toBe(written.size - 4); // minus the 4 pre-existing seed lines
    }
  });
});
