import { describe, expect, test } from 'bun:test';
import { type AppConfig, TRANSITIONS, type WorkerState } from '../../src/config/types';
import { encodeMessage, NdjsonFramer } from '../../src/control/protocol';
import { CrashRecovery } from '../../src/core/backoff';
import { WorkerLifecycle } from '../../src/core/lifecycle';

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function integer(next: () => number, maxExclusive: number): number {
  return Math.floor(next() * maxExclusive);
}

const states = Object.keys(TRANSITIONS) as WorkerState[];

describe('model-based invariants', () => {
  test('worker lifecycle never accepts an edge outside the transition model', () => {
    for (let seed = 1; seed <= 32; seed++) {
      const next = random(seed);
      const lifecycle = new WorkerLifecycle();
      const observed: Array<[WorkerState, WorkerState]> = [];
      lifecycle.onStateChange((_workerId, from, to) => observed.push([from, to]));
      let modelState: WorkerState = 'spawning';

      for (let step = 0; step < 1_000; step++) {
        const target = states[integer(next, states.length)];
        const expected = TRANSITIONS[modelState].includes(target);
        const beforeEvents = observed.length;
        expect(lifecycle.canTransition(modelState, target)).toBe(expected);
        expect(lifecycle.transition(seed, modelState, target)).toBe(expected);
        expect(observed.length - beforeEvents).toBe(expected ? 1 : 0);
        if (expected) modelState = target;
      }

      expect(observed.every(([from, to]) => TRANSITIONS[from].includes(to))).toBe(true);
    }
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
      for (let seed = 1; seed <= 24; seed++) {
        const next = random(seed);
        const recovery = new CrashRecovery();
        const model = new Map<
          string,
          { consecutive: number; windowStart: number; restartsInWindow: number; total: number }
        >();
        let now = 10_000;
        Date.now = () => now;

        for (let step = 0; step < 500; step++) {
          now += integer(next, 1_500);
          const namespace = `app-${integer(next, 3)}`;
          const workerId = integer(next, 3);
          const key = `${namespace}:${workerId}`;
          const action = integer(next, 5);

          if (action <= 2) {
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
          } else if (action === 3) {
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
      }
    } finally {
      Date.now = originalNow;
    }
  });

  test('NDJSON framing is invariant under arbitrary byte partitioning', () => {
    const encoder = new TextEncoder();
    for (let seed = 1; seed <= 64; seed++) {
      const next = random(seed);
      const expected = Array.from({ length: 1 + integer(next, 20) }, (_, index) => ({
        index,
        text: ['plain', 'caffè', '🚀', '東京', 'مرحبا'][integer(next, 5)],
        value: integer(next, 1_000_000),
      }));
      const bytes = encoder.encode(expected.map((message) => encodeMessage(message)).join(''));
      const framer = new NdjsonFramer();
      const actual: object[] = [];

      for (let offset = 0; offset < bytes.length; ) {
        const width = 1 + integer(next, 17);
        actual.push(...framer.push(bytes.slice(offset, offset + width)));
        offset += width;
      }

      expect(actual).toEqual(expected);
    }
  });
});
