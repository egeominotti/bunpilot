// ---------------------------------------------------------------------------
// h18 — LogManager.pipeStream must never abandon a child stream un-cancelled.
//
// Invariant: pipeStream is the ONLY consumer of a managed child's stdout /
// stderr ReadableStream. If it stops consuming (writer.write throws: ENOSPC,
// ENOENT after `rm -rf` of the log dir, EISDIR, EACCES, ...) it MUST cancel the
// stream so the OS pipe applies backpressure to the child. Today the try/catch
// sits OUTSIDE the read loop and `finally` only calls `reader.releaseLock()`,
// so Bun's pipe source keeps pulling from the child fd and queues every chunk
// in the daemon's heap forever -> unbounded RSS growth -> OOM-killed daemon.
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { LogsConfig } from '../../src/config/types';
import { LogManager } from '../../src/logs/manager';
import { makeTempDir } from '../_helpers/tmp';

// -- deterministic PRNG (mulberry32) ----------------------------------------
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    try {
      await fn();
    } catch {
      /* best effort */
    }
  }
});

const MB = 1_000_000;

// The child emits a bounded, deterministic total so a *failing* run cannot OOM
// the test machine: it is the ceiling on what the daemon can buffer.
const TOTAL_CHILD_BYTES = 400 * MB;
// Generous headroom over ordinary test-process noise. A violating run buffers
// hundreds of MB; an obedient pipe buffers at most one in-flight chunk.
const MAX_ALLOWED_GROWTH = 120 * MB;

function sampleRss(): number {
  Bun.gc(true);
  return process.memoryUsage.rss();
}

test('pipeStream cancels the child stream when the log writer fails (no unbounded heap growth)', async () => {
  // Seeded so the shape of the child's output is reproducible and printable.
  const SEED = 0x18cafe;
  const rand = prng(SEED);
  const lineLen = 40_000 + Math.floor(rand() * 20_000); // 40k..60k bytes/line
  const lines = Math.ceil(TOTAL_CHILD_BYTES / (lineLen + 1));

  const root = makeTempDir('bunpilot-h18-');
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  const app = 'blk';
  // Poison the stdout log path: it is a DIRECTORY, so appendFileSync throws
  // EISDIR on the very first write. Stand-in for ENOSPC / ENOENT / EACCES,
  // which are the real-world triggers (disk full, operator `rm -rf` of the
  // log dir, permissions change).
  mkdirSync(join(root, app, `${app}-0-out.log`), { recursive: true });

  const mgr = new LogManager(root);
  cleanups.push(() => mgr.closeAll());

  const cfg: LogsConfig = { maxSize: 512 * MB, maxFiles: 3 };

  const child = Bun.spawn(
    [
      'bun',
      '-e',
      `const s = "x".repeat(${lineLen});
       for (let i = 0; i < ${lines}; i++) console.log(s);`,
    ],
    { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
  );
  cleanups.push(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  });

  const before = sampleRss();

  mgr.pipeOutput(
    app,
    0,
    child.stdout as ReadableStream,
    child.stderr as ReadableStream,
    cfg,
    false,
  );

  // Give the pipe time to hit the write error and then either (correct) cancel
  // the stream, or (bug) sit there while Bun's pipe source drains the child's
  // entire output into the heap.
  const samples: number[] = [];
  for (let i = 0; i < 6; i++) {
    await Bun.sleep(500);
    samples.push(process.memoryUsage.rss());
  }

  const after = sampleRss();
  const growth = after - before;
  const peak = Math.max(...samples) - before;

  const fmt = (n: number) => `${(n / MB).toFixed(1)}MB`;
  if (growth >= MAX_ALLOWED_GROWTH || peak >= MAX_ALLOWED_GROWTH) {
    console.error(
      `h18 FAIL seed=0x${SEED.toString(16)} lineLen=${lineLen} lines=${lines}\n` +
        `  rss before=${fmt(before)} after=${fmt(after)} growth=${fmt(growth)} peak=${fmt(peak)}\n` +
        `  samples=${samples.map((s) => fmt(s - before)).join(' ')}`,
    );
  }

  // The daemon must not have absorbed the child's output into its own heap.
  expect(peak).toBeLessThan(MAX_ALLOWED_GROWTH);
  expect(growth).toBeLessThan(MAX_ALLOWED_GROWTH);
}, 25_000);
