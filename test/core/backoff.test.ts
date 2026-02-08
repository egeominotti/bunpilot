// ---------------------------------------------------------------------------
// bunpilot – CrashRecovery Unit Tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import { CrashRecovery } from '../../src/core/backoff';
import type { AppConfig } from '../../src/config/types';

// ---------------------------------------------------------------------------
// Helper: minimal AppConfig used across all tests
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'test',
    script: 'test.ts',
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    ...overrides,
  };
}

describe('CrashRecovery', () => {
  let recovery: CrashRecovery;
  const config = makeConfig();

  beforeEach(() => {
    recovery = new CrashRecovery();
  });

  // -----------------------------------------------------------------------
  // Basic crash handling
  // -----------------------------------------------------------------------
  describe('onWorkerCrash', () => {
    test('first crash returns restart', () => {
      const result = recovery.onWorkerCrash(1, config);
      expect(result).toBe('restart');
    });

    test('crashes within maxRestarts return restart', () => {
      expect(recovery.onWorkerCrash(1, config)).toBe('restart'); // 1
      expect(recovery.onWorkerCrash(1, config)).toBe('restart'); // 2
      expect(recovery.onWorkerCrash(1, config)).toBe('restart'); // 3
    });

    test('exceeding maxRestarts returns give-up', () => {
      recovery.onWorkerCrash(1, config); // 1
      recovery.onWorkerCrash(1, config); // 2
      recovery.onWorkerCrash(1, config); // 3
      const result = recovery.onWorkerCrash(1, config); // 4 -> exceeds 3
      expect(result).toBe('give-up');
    });
  });

  // -----------------------------------------------------------------------
  // Exponential backoff delay
  // -----------------------------------------------------------------------
  describe('exponential delay', () => {
    test('delay doubles with each consecutive crash', () => {
      // crash 1: initial * 2^0 = 1000
      recovery.onWorkerCrash(1, config);
      const state1 = recovery.getState(1)!;
      const delay1 = state1.nextRestartAt - state1.lastCrashAt;
      expect(delay1).toBe(1_000);

      // crash 2: initial * 2^1 = 2000
      recovery.onWorkerCrash(1, config);
      const state2 = recovery.getState(1)!;
      const delay2 = state2.nextRestartAt - state2.lastCrashAt;
      expect(delay2).toBe(2_000);

      // crash 3: initial * 2^2 = 4000
      recovery.onWorkerCrash(1, config);
      const state3 = recovery.getState(1)!;
      const delay3 = state3.nextRestartAt - state3.lastCrashAt;
      expect(delay3).toBe(4_000);
    });

    test('delay is capped at backoff.max', () => {
      const smallMaxConfig = makeConfig({
        maxRestarts: 100,
        backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
      });

      // 16 consecutive crashes: 1000 * 2^15 = 32768000 which exceeds 30000
      for (let i = 0; i < 16; i++) {
        recovery.onWorkerCrash(1, smallMaxConfig);
      }

      const state = recovery.getState(1)!;
      const delay = state.nextRestartAt - state.lastCrashAt;
      expect(delay).toBe(30_000);
    });
  });

  // -----------------------------------------------------------------------
  // Worker stable resets consecutive crashes
  // -----------------------------------------------------------------------
  describe('onWorkerStable', () => {
    test('resets consecutiveCrashes to zero', () => {
      recovery.onWorkerCrash(1, config);
      recovery.onWorkerCrash(1, config);
      expect(recovery.getState(1)!.consecutiveCrashes).toBe(2);

      recovery.onWorkerStable(1);
      expect(recovery.getState(1)!.consecutiveCrashes).toBe(0);
    });

    test('after stable, next crash delay restarts from initial', () => {
      recovery.onWorkerCrash(1, config); // crash 1
      recovery.onWorkerCrash(1, config); // crash 2
      recovery.onWorkerStable(1);        // stable -> reset consecutive

      recovery.onWorkerCrash(1, config); // crash 1 again (fresh curve)
      const state = recovery.getState(1)!;
      const delay = state.nextRestartAt - state.lastCrashAt;
      expect(delay).toBe(1_000);
    });

    test('is a no-op for an unknown worker', () => {
      // Should not throw
      recovery.onWorkerStable(999);
      expect(recovery.getState(999)).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------
  describe('reset', () => {
    test('clears all state for a specific worker', () => {
      recovery.onWorkerCrash(1, config);
      recovery.onWorkerCrash(2, config);

      recovery.reset(1);

      expect(recovery.getState(1)).toBeUndefined();
      expect(recovery.getState(2)).toBeDefined();
    });
  });

  describe('resetAll', () => {
    test('clears state for every worker', () => {
      recovery.onWorkerCrash(1, config);
      recovery.onWorkerCrash(2, config);
      recovery.onWorkerCrash(3, config);

      recovery.resetAll();

      expect(recovery.getState(1)).toBeUndefined();
      expect(recovery.getState(2)).toBeUndefined();
      expect(recovery.getState(3)).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Sliding window
  // -----------------------------------------------------------------------
  describe('sliding window', () => {
    test('resets restartsInWindow after maxRestartWindow elapses', () => {
      const shortWindowConfig = makeConfig({ maxRestartWindow: 100 });

      // Simulate 3 crashes immediately
      recovery.onWorkerCrash(1, shortWindowConfig);
      recovery.onWorkerCrash(1, shortWindowConfig);
      recovery.onWorkerCrash(1, shortWindowConfig);

      expect(recovery.getState(1)!.restartsInWindow).toBe(3);

      // Manually advance the windowStart so the next crash sees an elapsed window.
      // This simulates time passing beyond maxRestartWindow.
      const state = recovery.getState(1)!;
      state.windowStart = Date.now() - 200; // 200ms ago (exceeds 100ms window)

      const result = recovery.onWorkerCrash(1, shortWindowConfig);
      // Window should have been reset, so restartsInWindow is now 1 again.
      expect(recovery.getState(1)!.restartsInWindow).toBe(1);
      expect(result).toBe('restart');
    });
  });

  // -----------------------------------------------------------------------
  // getDelay
  // -----------------------------------------------------------------------
  describe('getDelay', () => {
    test('returns 0 for unknown worker', () => {
      expect(recovery.getDelay(999)).toBe(0);
    });

    test('returns remaining delay after a crash', () => {
      recovery.onWorkerCrash(1, config);
      const delay = recovery.getDelay(1);
      // The delay should be positive and at most the initial backoff value
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(1_000);
    });
  });
});
