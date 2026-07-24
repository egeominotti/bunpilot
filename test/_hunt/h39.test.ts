// ---------------------------------------------------------------------------
// h39 — `bunpilot logs` starves stderr: the alphabetically-last stream drains
//       the whole tail budget.
// ---------------------------------------------------------------------------
//
// src/logs/manager.ts:57-60 names a worker's streams `${app}-${id}-out.log` and
// `${app}-${id}-err.log`. src/logs/reader.ts:18-23 (`compareRotatedLogs`) sorts
// by BASE NAME first via localeCompare, so 'app-0-err' < 'app-0-out' and the
// stdout file is always LAST. src/logs/reader.ts:41 then walks the sorted array
// from the END and breaks the moment `result.length >= maxLines` — so a chatty
// stdout file alone can consume the entire budget and the stderr file holding
// the crash reason is never even opened.
//
// Invariant under test (LOG-7, the tail contract): when the caller asks for at
// least as many lines as the app has non-empty streams, no whole stream may be
// silently dropped from the tail. Concretely: a crash written to stderr must be
// visible in `bunpilot logs <app>` regardless of how much stdout was produced.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLogLines } from '../../src/logs/reader';

function makeRoot(): string {
  return mkdtempSync(join('/private/tmp', 'h39-logs-'));
}

/** Deterministic mulberry32 PRNG so any failure reports a reproducible seed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('h39: a fatal stderr line survives a chatty stdout (CLI default: 50 lines)', () => {
  const root = makeRoot();
  try {
    const appDir = join(root, 'app');
    mkdirSync(appDir, { recursive: true });

    // Exactly what a 1-worker app produces (src/logs/manager.ts:57-60).
    const stdout = Array.from({ length: 60 }, (_, i) => `out-${i}`).join('\n');
    writeFileSync(join(appDir, 'app-0-out.log'), `${stdout}\n`);
    writeFileSync(join(appDir, 'app-0-err.log'), 'FATAL: crashed\n');

    const tail = readLogLines(root, 'app', 50); // `bunpilot logs app`

    expect({ hasFatal: tail.includes('FATAL: crashed'), sample: tail.slice(0, 2) }).toEqual({
      hasFatal: true,
      sample: tail.slice(0, 2),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('h39: no non-empty stream is dropped when the budget exceeds the stream count', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const random = prng(seed);
    const root = makeRoot();
    try {
      const appDir = join(root, 'app');
      mkdirSync(appDir, { recursive: true });

      const workers = 1 + Math.floor(random() * 4); // instances: 1..4
      // Newest line of every stream — an honest tail must show each of them.
      const newestPerStream: string[] = [];

      for (let worker = 0; worker < workers; worker++) {
        const outCount = 15 + Math.floor(random() * 26); // 15..40
        const errCount = 1 + Math.floor(random() * 4); // 1..4
        const out = Array.from({ length: outCount }, (_, i) => `w${worker}-out-${i}`);
        const err = Array.from({ length: errCount }, (_, i) => `w${worker}-err-${i}`);

        writeFileSync(join(appDir, `app-${worker}-out.log`), `${out.join('\n')}\n`);
        writeFileSync(join(appDir, `app-${worker}-err.log`), `${err.join('\n')}\n`);

        newestPerStream.push(out[out.length - 1], err[err.length - 1]);
      }

      const streamCount = workers * 2;
      const maxLines = streamCount * 3; // generous: 3 lines of budget per stream

      const tail = readLogLines(root, 'app', maxLines);
      const missing = newestPerStream.filter((marker) => !tail.includes(marker));

      expect({ seed, workers, maxLines, missing }).toEqual({
        seed,
        workers,
        maxLines,
        missing: [],
      });
      expect(tail.length).toBeLessThanOrEqual(maxLines);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
