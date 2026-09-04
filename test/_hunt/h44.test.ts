// ---------------------------------------------------------------------------
// h44 — SDK-07/SDK-11: runShutdown() must run EVERY registered handler and
// must always terminate the process; the async IIFE must never reject.
//
// Hypothesis under test: src/sdk/worker.ts:143
//   const cleanup = Promise.allSettled([...shutdownHandlers].map((h) => h()));
// `.map` invokes each handler SYNCHRONOUSLY. Promise.allSettled only absorbs
// *rejected promises*, never a synchronous `throw` out of the map callback.
// A single non-async handler that throws (e.g. `() => db.close()` where `db`
// is undefined) therefore:
//   1. skips every later handler,
//   2. never reaches `process.exit(0)`,
//   3. leaves `shutdownPromise` permanently REJECTED (poisoned latch), so a
//      follow-up SIGTERM / shutdown message runs no handlers at all,
//   4. produces an unhandled rejection -> worker dies with exit code 1, which
//      the master classifies as a crash.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';

import { bunpilotOnShutdown } from '../../src/sdk/worker';

// --- seeded deterministic PRNG ---------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Behavior = 'ok' | 'sync-throw' | 'async-reject' | 'async-ok';
const BEHAVIORS: Behavior[] = ['ok', 'sync-throw', 'async-reject', 'async-ok'];

const SLOT_COUNT = 4;

// Per-iteration mutable state. The SDK offers no way to unregister handlers,
// so we register SLOT_COUNT stable delegating handlers exactly once and swap
// their behavior between iterations.
let behaviors: Behavior[] = Array.from({ length: SLOT_COUNT }, () => 'ok');
let calls: number[] = [];
let exitCalls: number[] = [];

const originalExit = process.exit;
const originalSend = process.send;
const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

// Keep the SDK's `send()` from writing to a real IPC channel.
(process as { send?: unknown }).send = () => true;
// `process.exit(0)` must be reached; stub it so the test survives.
(process as { exit: unknown }).exit = (code?: number) => {
  exitCalls.push(code ?? 0);
};
process.on('unhandledRejection', onUnhandled);

for (let slot = 0; slot < SLOT_COUNT; slot++) {
  const index = slot;
  bunpilotOnShutdown((): Promise<void> | void => {
    calls.push(index);
    const behavior = behaviors[index];
    if (behavior === 'sync-throw') {
      // The README-style `() => db.close()` where `db` is undefined.
      throw new TypeError(`slot ${index} exploded`);
    }
    if (behavior === 'async-reject') {
      return Promise.reject(new Error(`slot ${index} rejected`));
    }
    if (behavior === 'async-ok') {
      return Promise.resolve();
    }
    return undefined;
  });
}

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  (process as { exit: unknown }).exit = originalExit;
  if (originalSend) (process as { send?: unknown }).send = originalSend;
  else delete (process as { send?: unknown }).send;
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test('every shutdown handler runs and process.exit(0) is reached, even when one throws synchronously', async () => {
  const ITERATIONS = 16;

  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    const seed = 1_000_003 + iteration;
    const rand = mulberry32(seed);

    if (iteration === 0) {
      // Deterministic minimal repro: first handler throws synchronously.
      behaviors = ['sync-throw', 'ok', 'async-ok', 'ok'];
    } else {
      behaviors = Array.from({ length: SLOT_COUNT }, () => {
        return BEHAVIORS[Math.floor(rand() * BEHAVIORS.length)] as Behavior;
      });
      // Guarantee at least one synchronous throw somewhere in the set.
      behaviors[Math.floor(rand() * SLOT_COUNT)] = 'sync-throw';
    }

    const plan = JSON.stringify(behaviors);
    calls = [];
    exitCalls = [];
    unhandled.length = 0;

    process.emit('message', { type: 'shutdown', timeout: 60 });
    await sleep(25);

    const label = `seed=${seed} iteration=${iteration} behaviors=${plan} ran=${JSON.stringify(calls)} exitCalls=${JSON.stringify(exitCalls)}`;

    // SDK-07: every registered cleanup handler must run.
    expect(
      calls.slice().sort((a, b) => a - b),
      `not every handler ran — ${label}`,
    ).toEqual([0, 1, 2, 3]);

    // SDK-07: the worker must always terminate cleanly.
    expect(exitCalls, `process.exit(0) was never reached — ${label}`).toEqual([0]);

    // SDK-11: the async IIFE must never reject (all call sites use bare `void`).
    expect(unhandled, `runShutdown() rejected — ${label}`).toEqual([]);
  }
});

test('a shutdown request after a throwing handler still runs handlers and exits (latch not poisoned)', async () => {
  // The previous test left `shutdownPromise` in whatever state the SDK put it
  // in. A correct implementation resolved it and reset the latch to null; the
  // buggy implementation left a permanently REJECTED promise, so `runShutdown`
  // short-circuits at `if (shutdownPromise) return shutdownPromise` forever.
  behaviors = ['ok', 'ok', 'ok', 'ok'];
  calls = [];
  exitCalls = [];
  unhandled.length = 0;

  process.emit('message', { type: 'shutdown', timeout: 60 });
  await sleep(25);

  const label = `ran=${JSON.stringify(calls)} exitCalls=${JSON.stringify(exitCalls)}`;
  expect(
    calls.slice().sort((a, b) => a - b),
    `latch poisoned — ${label}`,
  ).toEqual([0, 1, 2, 3]);
  expect(exitCalls, `latch poisoned, never exits — ${label}`).toEqual([0]);
});
