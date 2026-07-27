// ---------------------------------------------------------------------------
// h30 — readLogLines() drains its whole budget on the last-sorted log group
// ---------------------------------------------------------------------------
//
// `compareRotatedLogs` orders files by BASE NAME first, so an app's files sort
// as [app-0-err..., app-0-out..., app-1-err..., app-1-out...]. readLogLines()
// then walks that array newest-index -> oldest-index and stops as soon as
// `result.length >= maxLines`. The single last group (`app-{N-1}-out`) can
// satisfy the whole budget by itself, so every other stream — crucially the
// stderr file holding the crash reason, and every worker except the last — is
// never opened.
//
// Invariant under test (the one the tail contract implies): when the caller
// asks for at least as many lines as there are log streams, no non-empty
// stream may be dropped entirely from the tail.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLogLines } from '../../src/logs/reader';
import { makeTempDir } from '../_helpers/tmp';

function makeRoot(): string {
  return makeTempDir('h30-logs-');
}

/** Deterministic 32-bit PRNG (mulberry32) so a failure reports a usable seed. */
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

test('h30: stderr tail survives a stdout file larger than maxLines', () => {
  void tmpdir();
  const root = makeRoot();
  try {
    const appDir = join(root, 'myapp');
    mkdirSync(appDir, { recursive: true });

    const stdout = Array.from({ length: 60 }, (_, i) => `out line ${i}`).join('\n');
    writeFileSync(join(appDir, 'myapp-0-out.log'), `${stdout}\n`);
    writeFileSync(join(appDir, 'myapp-0-err.log'), 'FATAL: boom\n');

    const lines = readLogLines(root, 'myapp', 50);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes('FATAL: boom'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('h30: every non-empty stream is represented when maxLines >= stream count', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const random = prng(seed);
    const root = makeRoot();
    try {
      const app = 'app';
      const appDir = join(root, app);
      mkdirSync(appDir, { recursive: true });

      const workers = 1 + Math.floor(random() * 4); // 1..4
      const markers: string[] = [];

      for (let worker = 0; worker < workers; worker++) {
        const outCount = 20 + Math.floor(random() * 21); // 20..40
        const errCount = 1 + Math.floor(random() * 5); // 1..5

        const outLines = Array.from({ length: outCount }, (_, i) => `w${worker}-out-${i}`);
        const errLines = Array.from({ length: errCount }, (_, i) => `w${worker}-err-${i}`);

        writeFileSync(join(appDir, `${app}-${worker}-out.log`), `${outLines.join('\n')}\n`);
        writeFileSync(join(appDir, `${app}-${worker}-err.log`), `${errLines.join('\n')}\n`);

        // Newest line of each stream: it must appear in any honest tail.
        markers.push(outLines[outLines.length - 1], errLines[errLines.length - 1]);
      }

      const streams = workers * 2;
      const maxLines = streams * 2; // generous: 2 lines of budget per stream

      const tail = readLogLines(root, app, maxLines);
      const missing = markers.filter((marker) => !tail.includes(marker));

      expect({ seed, workers, maxLines, missing, tailSample: tail.slice(0, 4) }).toEqual({
        seed,
        workers,
        maxLines,
        missing: [],
        tailSample: tail.slice(0, 4),
      });
      expect(tail.length).toBeLessThanOrEqual(maxLines);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
