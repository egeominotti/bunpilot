import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { type AppConfig, TRANSITIONS, type WorkerState } from '../../src/config/types';
import { encodeMessage, NdjsonFramer } from '../../src/control/protocol';
import { CrashRecovery } from '../../src/core/backoff';
import { WorkerLifecycle } from '../../src/core/lifecycle';

const states = Object.keys(TRANSITIONS) as WorkerState[];
const lifecycleSequence = fc.array(fc.constantFrom(...states), {
  minLength: 1_000,
  maxLength: 1_000,
});
const backoffSequence = fc.array(
  fc.record({
    elapsed: fc.integer({ min: 0, max: 1_499 }),
    namespace: fc.integer({ min: 0, max: 2 }),
    workerId: fc.integer({ min: 0, max: 2 }),
    action: fc.integer({ min: 0, max: 4 }),
  }),
  { minLength: 500, maxLength: 500 },
);
const messageArbitrary = fc.record({
  text: fc.constantFrom('plain', 'caffè', '🚀', '東京', 'مرحبا'),
  value: fc.integer({ min: 0, max: 999_999 }),
});

describe('model-based invariants', () => {
  test('worker lifecycle never accepts an edge outside the transition model', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 32 }), lifecycleSequence, (workerId, targets) => {
        const lifecycle = new WorkerLifecycle();
        const observed: Array<[number, WorkerState, WorkerState]> = [];
        lifecycle.onStateChange((id, from, to) => observed.push([id, from, to]));
        let modelState: WorkerState = 'spawning';

        for (const target of targets) {
          const expected = TRANSITIONS[modelState].includes(target);
          const beforeEvents = observed.length;
          expect(lifecycle.canTransition(modelState, target)).toBe(expected);
          expect(lifecycle.transition(workerId, modelState, target)).toBe(expected);
          expect(observed.length - beforeEvents).toBe(expected ? 1 : 0);
          if (expected) modelState = target;
        }

        expect(
          observed.every(([id, from, to]) => id === workerId && TRANSITIONS[from].includes(to)),
        ).toBe(true);
      }),
      { seed: 0x1c1e, numRuns: 32 },
    );
  });

  test('backoff matches a reference model and remains isolated by app and worker', () => {
    const config: AppConfig = {
      name: 'model',
      script: 'model.ts',
      instances: 1,
      maxRestarts: 4,
      maxRestartWindow: 5_000,
      minUptime: 1_000,
      killTimeout: 1_000,
      shutdownSignal: 'SIGTERM',
      readyTimeout: 1_000,
      backoff: { initial: 100, multiplier: 2, max: 1_600 },
    };
    const originalNow = Date.now;

    try {
      fc.assert(
        fc.property(backoffSequence, (operations) => {
          const recovery = new CrashRecovery();
          const model = new Map<
            string,
            { consecutive: number; windowStart: number; restartsInWindow: number; total: number }
          >();
          let now = 10_000;
          Date.now = () => now;

          for (const operation of operations) {
            now += operation.elapsed;
            const namespace = `app-${operation.namespace}`;
            const workerId = operation.workerId;
            const key = `${namespace}:${workerId}`;

            if (operation.action <= 2) {
              let expected = model.get(key);
              if (!expected) {
                expected = { consecutive: 0, windowStart: now, restartsInWindow: 0, total: 0 };
                model.set(key, expected);
              }
              if (now - expected.windowStart >= config.maxRestartWindow) {
                expected.windowStart = now;
                expected.restartsInWindow = 0;
              }
              expected.consecutive++;
              expected.restartsInWindow++;
              expected.total++;

              const decision = recovery.onWorkerCrash(workerId, config, namespace);
              const actual = recovery.getState(workerId, namespace)!;
              const delay = Math.min(
                config.backoff.initial * config.backoff.multiplier ** (expected.consecutive - 1),
                config.backoff.max,
              );
              expect(decision).toBe(
                expected.restartsInWindow > config.maxRestarts ? 'give-up' : 'restart',
              );
              expect(actual.consecutiveCrashes).toBe(expected.consecutive);
              expect(actual.restartsInWindow).toBe(expected.restartsInWindow);
              expect(actual.totalRestarts).toBe(expected.total);
              expect(actual.nextRestartAt - actual.lastCrashAt).toBe(delay);
            } else if (operation.action === 3) {
              recovery.onWorkerStable(workerId, namespace);
              const expected = model.get(key);
              if (expected) expected.consecutive = 0;
            } else {
              recovery.reset(workerId, namespace);
              model.delete(key);
            }

            for (const [modelKey, expected] of model) {
              const separator = modelKey.lastIndexOf(':');
              const app = modelKey.slice(0, separator);
              const id = Number(modelKey.slice(separator + 1));
              const actual = recovery.getState(id, app)!;
              expect(actual.consecutiveCrashes).toBe(expected.consecutive);
              expect(actual.totalRestarts).toBe(expected.total);
            }
          }
        }),
        { seed: 0xbac0ff, numRuns: 24 },
      );
    } finally {
      Date.now = originalNow;
    }
  });

  test('NDJSON framing is invariant under arbitrary byte partitioning', () => {
    const encoder = new TextEncoder();
    fc.assert(
      fc.property(
        fc.array(messageArbitrary, { minLength: 1, maxLength: 20 }),
        fc.array(fc.integer({ min: 1, max: 17 }), { minLength: 1, maxLength: 64 }),
        (messages, widths) => {
          const expected = messages.map((message, index) => ({ index, ...message }));
          const bytes = encoder.encode(expected.map((message) => encodeMessage(message)).join(''));
          const framer = new NdjsonFramer();
          const actual: object[] = [];

          for (let offset = 0, chunk = 0; offset < bytes.length; chunk++) {
            const width = widths[chunk % widths.length];
            actual.push(...framer.push(bytes.slice(offset, offset + width)));
            offset += width;
          }

          expect(actual).toEqual(expected);
        },
      ),
      { seed: 0x4e444a, numRuns: 64 },
    );
  });
});
