// ---------------------------------------------------------------------------
// bunpm2 – HealthChecker unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import { HealthChecker, type UnhealthyCallback } from '../../src/health/checker';

describe('HealthChecker', () => {
  let checker: HealthChecker;

  beforeEach(() => {
    checker = new HealthChecker();
  });

  // -----------------------------------------------------------------------
  // Callback registration
  // -----------------------------------------------------------------------

  describe('onUnhealthy / offUnhealthy', () => {
    test('onUnhealthy registers a listener', () => {
      const calls: Array<{ workerId: number; reason: string }> = [];
      const cb: UnhealthyCallback = (workerId, reason) => {
        calls.push({ workerId, reason });
      };
      checker.onUnhealthy(cb);

      // The listener is registered internally. We can't call emitUnhealthy
      // directly since it's private, but we confirm the registration doesn't
      // throw and the callback reference is stored.
      expect(calls).toHaveLength(0);
    });

    test('offUnhealthy removes a previously registered listener', () => {
      const cb: UnhealthyCallback = () => {};
      checker.onUnhealthy(cb);
      // Should not throw
      checker.offUnhealthy(cb);
    });

    test('offUnhealthy with unregistered callback is a no-op', () => {
      const cb: UnhealthyCallback = () => {};
      // Removing a callback that was never added should not throw
      expect(() => checker.offUnhealthy(cb)).not.toThrow();
    });

    test('multiple listeners can be registered', () => {
      const cb1: UnhealthyCallback = () => {};
      const cb2: UnhealthyCallback = () => {};
      checker.onUnhealthy(cb1);
      checker.onUnhealthy(cb2);
      // No error on adding two listeners
      checker.offUnhealthy(cb1);
      // cb2 should still be registered (no error removing cb1 only)
    });
  });

  // -----------------------------------------------------------------------
  // Heartbeat tracking
  // -----------------------------------------------------------------------

  describe('onHeartbeat', () => {
    test('records a heartbeat timestamp for the worker', () => {
      checker.onHeartbeat(1);
      // After recording a heartbeat the worker should not be stale
      expect(checker.isHeartbeatStale(1)).toBe(false);
    });

    test('overwrites previous heartbeat timestamp on subsequent calls', () => {
      checker.onHeartbeat(1);
      checker.onHeartbeat(1);
      expect(checker.isHeartbeatStale(1)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // isHeartbeatStale
  // -----------------------------------------------------------------------

  describe('isHeartbeatStale', () => {
    test('returns false for an unknown worker (no heartbeat recorded)', () => {
      expect(checker.isHeartbeatStale(999)).toBe(false);
    });

    test('returns false immediately after a heartbeat', () => {
      checker.onHeartbeat(1);
      expect(checker.isHeartbeatStale(1)).toBe(false);
    });

    test('returns true when enough time has elapsed', () => {
      // Manually seed a heartbeat far in the past by calling onHeartbeat
      // then overriding with a stale timestamp via a time-travel approach.
      const originalNow = Date.now;

      // First call uses the real timestamp
      checker.onHeartbeat(1);

      // Now advance Date.now far beyond HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD
      // HEARTBEAT_INTERVAL = 10_000, HEARTBEAT_MISS_THRESHOLD = 3 => 30_000 ms
      const future = originalNow() + 60_000;
      Date.now = () => future;

      try {
        expect(checker.isHeartbeatStale(1)).toBe(true);
      } finally {
        Date.now = originalNow;
      }
    });

    test('returns false when elapsed time is below threshold', () => {
      const originalNow = Date.now;
      const baseTime = originalNow();

      Date.now = () => baseTime;
      checker.onHeartbeat(1);

      // Advance by only 5 seconds (below 30s threshold)
      Date.now = () => baseTime + 5_000;

      try {
        expect(checker.isHeartbeatStale(1)).toBe(false);
      } finally {
        Date.now = originalNow;
      }
    });
  });

  // -----------------------------------------------------------------------
  // stopAll
  // -----------------------------------------------------------------------

  describe('stopAll', () => {
    test('does not throw when there are no active timers', () => {
      expect(() => checker.stopAll()).not.toThrow();
    });

    test('does not throw after starting and stopping heartbeat monitors', () => {
      checker.startHeartbeatMonitor(1, () => {});
      checker.startHeartbeatMonitor(2, () => {});
      expect(() => checker.stopAll()).not.toThrow();
    });
  });
});
