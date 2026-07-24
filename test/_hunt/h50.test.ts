// ---------------------------------------------------------------------------
// Hunt h50 — LOG-16: a stalled pipe must be cancelled when its drain window
// closes, so the `pipeStream` promise settles, `trackPipe`'s `finally` drops it
// from `activePipes`, and no later drain re-pays the 5 s timeout for a worker
// that is already gone.
//
// `drainPipes` (src/logs/manager.ts:168-177) only races the pending tasks
// against a 5 s timer — it never calls `stream.cancel()` nor aborts the reader.
// A stream that never reaches `{ done: true }` (real case: a grandchild that
// inherited the pipe write end, since ProcessManager kills a single pid and not
// the process group) therefore leaves its `pipeStream` promise pending forever.
//
// A bounded 5 s drain is by design; paying it again and again for the same dead
// worker, and never releasing the promise/stream/reader, is not.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LogsConfig } from '../../src/config/types';
import { LogManager } from '../../src/logs/manager';

const tempDir = mkdtempSync(join('/private/tmp', 'bunpilot-h50-'));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeLogsConfig(): LogsConfig {
  return { maxSize: 1024 * 1024, maxFiles: 5 };
}

/** Deterministic PRNG so chunk counts/payloads are reproducible from the seed. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/**
 * Delivers a few chunks and then STALLS forever: never closes, never errors —
 * exactly like a pipe whose write end is still held open by a survivor.
 */
function stalledStream(rng: () => number): ReadableStream<Uint8Array> {
  const chunkCount = 1 + Math.floor(rng() * 3);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < chunkCount; i++) {
        controller.enqueue(new Uint8Array([Math.floor(rng() * 256), 0x0a]));
      }
      // Intentionally no controller.close().
    },
  });
}

function activePipes(mgr: LogManager): Map<string, Set<unknown>> {
  return (mgr as unknown as { activePipes: Map<string, Set<unknown>> }).activePipes;
}

function trackedPipeCount(mgr: LogManager): number {
  let n = 0;
  for (const tasks of activePipes(mgr).values()) n += tasks.size;
  return n;
}

function describePipes(mgr: LogManager): string {
  const parts = [...activePipes(mgr)].map(([k, v]) => `${k}=${v.size}`);
  return parts.length > 0 ? parts.join(', ') : '<empty>';
}

test('LOG-16: a stalled pipe is released by its drain window, not leaked forever', async () => {
  const SEED = 20260723;
  const rng = makeRng(SEED);
  const failures: string[] = [];

  const mgr = new LogManager(tempDir);
  const config = makeLogsConfig();

  // Two relaunch generations of the same worker id, mimicking `retireWorker`
  // running once per restart.
  const ROUNDS = 2;
  for (let round = 0; round < ROUNDS; round++) {
    mgr.pipeOutput('app', 0, stalledStream(rng), stalledStream(rng), config, false);
    // Let the readers consume the buffered chunks and park on read().
    await Bun.sleep(50);

    const before = trackedPipeCount(mgr);
    if (before !== 2) {
      failures.push(
        `seed=${SEED} round=${round}: expected exactly 2 tracked pipes for the live generation, got ${before} (${describePipes(mgr)}) — earlier generations were never released`,
      );
    }

    // First close: the bounded 5 s drain window is legitimate here.
    await mgr.closeWorker('app', 0);
    await Bun.sleep(50);

    const after = trackedPipeCount(mgr);
    if (after !== 0) {
      failures.push(
        `seed=${SEED} round=${round}: activePipes still holds ${after} never-settling task(s) after closeWorker (${describePipes(mgr)}) — the stalled stream was never cancelled`,
      );
    }

    if (round === ROUNDS - 1) {
      // Close the same, already-retired worker again with no new pipes: it
      // must be instantaneous. If the stalled pipes were leaked it re-races
      // them and pays the full drain timeout all over again.
      const started = Bun.nanoseconds();
      await mgr.closeWorker('app', 0);
      const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
      if (elapsedMs >= 500) {
        failures.push(
          `seed=${SEED} round=${round}: a redundant closeWorker on an already-retired worker re-paid the drain timeout (${Math.round(elapsedMs)} ms)`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`LOG-16 violated\n  - ${failures.join('\n  - ')}`);
  }
  expect(trackedPipeCount(mgr)).toBe(0);
}, 25_000);
