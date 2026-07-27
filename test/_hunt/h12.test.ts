// ---------------------------------------------------------------------------
// h12 — SDK-11 / SDK-07: runShutdown() must isolate a throwing shutdown handler
// ---------------------------------------------------------------------------
//
// src/sdk/worker.ts:143
//   const cleanup = Promise.allSettled([...shutdownHandlers].map((h) => h()));
//
// The handlers are invoked inside `.map`, i.e. BEFORE `Promise.allSettled` is
// ever called. A *synchronous* throw from any handler therefore escapes the
// `.map` call, aborts the async IIFE, and:
//   - skips every handler registered after the thrower,
//   - skips `process.exit(0)` at line 150,
//   - leaves `shutdownPromise` (the latch at line 140) permanently REJECTED,
//   - produces an unhandled rejection (the IIFE is invoked as bare `void` at
//     lines 123 / 135 / 136, with no `.catch`).
//
// Invariant under test: every registered handler runs exactly once, and the
// worker always terminates via `process.exit(0)`, no matter what a handler
// does.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDir } from '../_helpers/tmp';

const WORKER_SRC = join(import.meta.dir, '..', '..', 'src', 'sdk', 'worker.ts');

/** Deterministic PRNG (mulberry32) so failures are reproducible from a seed. */
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

const tmpRoot = makeTempDir('bp-h12-');
afterAll(() => {
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// (a) property-based, in-process
// ---------------------------------------------------------------------------

test('a throwing shutdown handler never starves the other handlers or process.exit', async () => {
  const failures: string[] = [];

  for (let iteration = 0; iteration < 12; iteration++) {
    const seed = 1_000 + iteration * 7919;
    const rng = makeRng(seed);

    // Fresh module instance per iteration: the SDK keeps `shutdownHandlers`,
    // `shutdownPromise` and the "installed" flags in module scope.
    const mod = (await import(`${WORKER_SRC}?h12=${iteration}`)) as {
      bunpilotOnShutdown: (h: () => Promise<void> | void) => void;
    };

    const handlerCount = 2 + Math.floor(rng() * 4); // 2..5 handlers
    const throwerIndex = Math.floor(rng() * handlerCount);
    const runs = new Array<number>(handlerCount).fill(0);

    // Snapshot listeners so we can uninstall this iteration's SDK listeners.
    const msgBefore = new Set(process.listeners('message'));
    const termBefore = new Set(process.listeners('SIGTERM'));
    const intBefore = new Set(process.listeners('SIGINT'));

    const originalExit = process.exit;
    const exitCalls: unknown[] = [];
    (process as unknown as { exit: unknown }).exit = (code?: number) => {
      exitCalls.push(code);
    };

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);

    try {
      for (let i = 0; i < handlerCount; i++) {
        const index = i;
        if (index === throwerIndex) {
          mod.bunpilotOnShutdown(() => {
            runs[index] = (runs[index] ?? 0) + 1;
            throw new Error(`boom from handler ${index}`);
          });
        } else if (rng() < 0.5) {
          // async handler
          mod.bunpilotOnShutdown(async () => {
            runs[index] = (runs[index] ?? 0) + 1;
          });
        } else {
          mod.bunpilotOnShutdown(() => {
            runs[index] = (runs[index] ?? 0) + 1;
          });
        }
      }

      // Only this iteration's dispatcher should see the message.
      const dispatcher = process.listeners('message').find((l) => !msgBefore.has(l)) as
        | ((m: unknown) => void)
        | undefined;
      expect(dispatcher).toBeDefined();
      dispatcher?.({ type: 'shutdown', timeout: 100 });

      await new Promise((resolve) => setTimeout(resolve, 40));

      for (let i = 0; i < handlerCount; i++) {
        if (runs[i] !== 1) {
          failures.push(
            `seed=${seed} handlers=${handlerCount} thrower=${throwerIndex}: handler ${i} ran ${runs[i]} time(s), expected exactly 1`,
          );
        }
      }
      if (exitCalls.length !== 1 || exitCalls[0] !== 0) {
        failures.push(
          `seed=${seed} handlers=${handlerCount} thrower=${throwerIndex}: process.exit calls = ${JSON.stringify(exitCalls)}, expected [0]`,
        );
      }
      if (rejections.length !== 0) {
        failures.push(
          `seed=${seed} handlers=${handlerCount} thrower=${throwerIndex}: ${rejections.length} unhandled rejection(s) escaped runShutdown(): ${String((rejections[0] as Error)?.message ?? rejections[0])}`,
        );
      }
    } finally {
      (process as unknown as { exit: unknown }).exit = originalExit;
      process.off('unhandledRejection', onRejection);
      for (const l of process.listeners('message')) {
        if (!msgBefore.has(l)) process.off('message', l as () => void);
      }
      for (const l of process.listeners('SIGTERM')) {
        if (!termBefore.has(l)) process.off('SIGTERM', l as () => void);
      }
      for (const l of process.listeners('SIGINT')) {
        if (!intBefore.has(l)) process.off('SIGINT', l as () => void);
      }
    }
  }

  expect(failures).toEqual([]);
});

// ---------------------------------------------------------------------------
// (b) real child process: SIGTERM must produce a clean exit code 0
// ---------------------------------------------------------------------------
//
// The master (src/master/worker-handler.ts) classifies a worker exit while
// `state === 'online'` as a CRASH. A worker that dies with code 1 because its
// own shutdown pipeline rejected therefore gets counted as a crash, backed off
// and restarted.
// ---------------------------------------------------------------------------

test('worker with a throwing shutdown handler exits 0 on SIGTERM', async () => {
  const readyFile = join(tmpRoot, 'ready');
  const secondFile = join(tmpRoot, 'second-handler-ran');
  const fixture = join(tmpRoot, 'fixture.ts');
  writeFileSync(
    fixture,
    `import { bunpilotOnShutdown } from ${JSON.stringify(WORKER_SRC)};
import { writeFileSync } from 'node:fs';
import { makeTempDir } from '../_helpers/tmp';

bunpilotOnShutdown(() => {
  throw new Error('boom');
});
bunpilotOnShutdown(() => {
  // e.g. closing the DB / flushing writes: must still run
  writeFileSync(${JSON.stringify(secondFile)}, 'ok');
});

// keep the event loop alive
const keepAlive = setInterval(() => {}, 1000);
void keepAlive;
writeFileSync(${JSON.stringify(readyFile)}, 'ok');
`,
  );

  const proc = Bun.spawn(['bun', fixture], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: tmpRoot,
  });

  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !(await Bun.file(readyFile).exists())) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(await Bun.file(readyFile).exists()).toBe(true);

    process.kill(proc.pid, 'SIGTERM');
    const exitCode = await proc.exited;

    expect({
      exitCode,
      signalCode: proc.signalCode,
      secondHandlerRan: await Bun.file(secondFile).exists(),
    }).toEqual({
      exitCode: 0,
      signalCode: null,
      secondHandlerRan: true,
    });
  } finally {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await proc.exited.catch(() => undefined);
  }
}, 15_000);
