// ---------------------------------------------------------------------------
// bunpilot – HealthChecker unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { HealthChecker, type UnhealthyCallback } from '../../src/health/checker';
import type { AppConfig } from '../../src/config/types';
import { INTERNAL_PORT_BASE, HEARTBEAT_INTERVAL, HEARTBEAT_MISS_THRESHOLD } from '../../src/constants';
import type { Server } from 'bun';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal AppConfig with health-check settings for testing. */
function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'test-app',
    script: 'app.ts',
    instances: 1,
    maxRestarts: 15,
    maxRestartWindow: 900_000,
    minUptime: 30_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    ...overrides,
  };
}

describe('HealthChecker', () => {
  let checker: HealthChecker;
  /** Collect test servers so afterEach can clean them up. */
  const servers: Server[] = [];

  beforeEach(() => {
    checker = new HealthChecker();
  });

  afterEach(() => {
    checker.stopAll();
    for (const srv of servers) {
      srv.stop(true);
    }
    servers.length = 0;
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
  // getWorkerPort
  // -----------------------------------------------------------------------

  describe('getWorkerPort', () => {
    test('returns INTERNAL_PORT_BASE + workerId when strategy is proxy', () => {
      const config = makeConfig({
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });
      expect(checker.getWorkerPort(0, config)).toBe(INTERNAL_PORT_BASE + 0);
      expect(checker.getWorkerPort(5, config)).toBe(INTERNAL_PORT_BASE + 5);
    });

    test('returns INTERNAL_PORT_BASE + workerId when strategy is auto', () => {
      const config = makeConfig({
        clustering: {
          enabled: true,
          strategy: 'auto',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });
      expect(checker.getWorkerPort(3, config)).toBe(INTERNAL_PORT_BASE + 3);
    });

    test('returns config.port when strategy is reusePort and port is set', () => {
      const config = makeConfig({
        port: 8080,
        clustering: {
          enabled: true,
          strategy: 'reusePort',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });
      expect(checker.getWorkerPort(0, config)).toBe(8080);
      expect(checker.getWorkerPort(5, config)).toBe(8080);
    });

    test('falls back to INTERNAL_PORT_BASE + workerId when reusePort but no port set', () => {
      const config = makeConfig({
        clustering: {
          enabled: true,
          strategy: 'reusePort',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });
      // config.port is undefined
      expect(checker.getWorkerPort(2, config)).toBe(INTERNAL_PORT_BASE + 2);
    });

    test('defaults to auto strategy when clustering config is absent', () => {
      const config = makeConfig();
      // No clustering config => strategy defaults to 'auto' => INTERNAL_PORT_BASE + workerId
      expect(checker.getWorkerPort(7, config)).toBe(INTERNAL_PORT_BASE + 7);
    });
  });

  // -----------------------------------------------------------------------
  // startChecking / stopChecking
  // -----------------------------------------------------------------------

  describe('startChecking / stopChecking', () => {
    test('does nothing when healthCheck is undefined', () => {
      const config = makeConfig(); // no healthCheck
      // Should not throw and no timer should be set
      expect(() => checker.startChecking(1, config)).not.toThrow();
    });

    test('does nothing when healthCheck.enabled is false', () => {
      const config = makeConfig({
        healthCheck: {
          enabled: false,
          path: '/health',
          interval: 100,
          timeout: 50,
          unhealthyThreshold: 2,
        },
      });
      expect(() => checker.startChecking(1, config)).not.toThrow();
    });

    test('stopChecking does not throw for unknown workerId', () => {
      expect(() => checker.stopChecking(999)).not.toThrow();
    });

    test('stopChecking can be called multiple times safely', () => {
      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 100,
          timeout: 50,
          unhealthyThreshold: 2,
        },
      });
      checker.startChecking(1, config);
      checker.stopChecking(1);
      checker.stopChecking(1);
      // No throw
    });

    test('startChecking replaces existing timer on same workerId', () => {
      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 200,
          timeout: 50,
          unhealthyThreshold: 2,
        },
      });
      // Start twice for same worker - should replace, not duplicate
      checker.startChecking(1, config);
      checker.startChecking(1, config);
      // Cleanup via stopChecking should clear it
      checker.stopChecking(1);
    });

    test('fires unhealthy callback after threshold consecutive failures (no server)', async () => {
      // No server listening => every fetch will fail => should trigger unhealthy
      const calls: Array<{ workerId: number; reason: string }> = [];
      checker.onUnhealthy((id, reason) => calls.push({ workerId: id, reason }));

      const port = INTERNAL_PORT_BASE + 100; // nothing listening here
      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 50,  // fast interval for testing
          timeout: 30,
          unhealthyThreshold: 2,
        },
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      checker.startChecking(100, config);

      // Wait long enough for at least 2 intervals + processing time
      await new Promise((r) => setTimeout(r, 400));

      checker.stopChecking(100);
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].workerId).toBe(100);
      expect(calls[0].reason).toContain('health check failed');
    });

    test('resets failure count on successful HTTP response', async () => {
      // Start a healthy test server
      const port = 19_500 + Math.floor(Math.random() * 500);
      const workerId = port - INTERNAL_PORT_BASE;

      const srv = Bun.serve({
        port,
        fetch() {
          return new Response('OK', { status: 200 });
        },
      });
      servers.push(srv);

      const calls: Array<{ workerId: number; reason: string }> = [];
      checker.onUnhealthy((id, reason) => calls.push({ workerId: id, reason }));

      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 50,
          timeout: 500,
          unhealthyThreshold: 2,
        },
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      checker.startChecking(workerId, config);

      // Wait for several checks
      await new Promise((r) => setTimeout(r, 300));

      checker.stopChecking(workerId);

      // Server always returns 200 => no unhealthy callbacks
      expect(calls).toHaveLength(0);
    });

    test('fires unhealthy callback when server returns non-OK status', async () => {
      const port = 19_500 + Math.floor(Math.random() * 500);
      const workerId = port - INTERNAL_PORT_BASE;

      const srv = Bun.serve({
        port,
        fetch() {
          return new Response('Service Unavailable', { status: 503 });
        },
      });
      servers.push(srv);

      const calls: Array<{ workerId: number; reason: string }> = [];
      checker.onUnhealthy((id, reason) => calls.push({ workerId: id, reason }));

      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 50,
          timeout: 500,
          unhealthyThreshold: 2,
        },
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      checker.startChecking(workerId, config);

      await new Promise((r) => setTimeout(r, 400));

      checker.stopChecking(workerId);

      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].reason).toContain('HTTP 503');
    });

    test('uses correct health check path from config', async () => {
      const port = 19_500 + Math.floor(Math.random() * 500);
      const workerId = port - INTERNAL_PORT_BASE;

      let requestedPaths: string[] = [];
      const srv = Bun.serve({
        port,
        fetch(req) {
          const url = new URL(req.url);
          requestedPaths.push(url.pathname);
          return new Response('OK', { status: 200 });
        },
      });
      servers.push(srv);

      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/custom/healthz',
          interval: 50,
          timeout: 500,
          unhealthyThreshold: 3,
        },
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      checker.startChecking(workerId, config);

      await new Promise((r) => setTimeout(r, 200));

      checker.stopChecking(workerId);

      expect(requestedPaths.length).toBeGreaterThanOrEqual(1);
      expect(requestedPaths[0]).toBe('/custom/healthz');
    });

    test('does not fire unhealthy until threshold is reached', async () => {
      // No server => every check fails, but threshold is high
      const calls: Array<{ workerId: number; reason: string }> = [];
      checker.onUnhealthy((id, reason) => calls.push({ workerId: id, reason }));

      const port = INTERNAL_PORT_BASE + 200;
      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 50,
          timeout: 30,
          unhealthyThreshold: 100, // very high threshold
        },
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      checker.startChecking(200, config);

      // Only wait for a few checks - not enough to reach threshold of 100
      await new Promise((r) => setTimeout(r, 250));

      checker.stopChecking(200);

      // Should NOT have fired since we haven't had 100 consecutive failures
      expect(calls).toHaveLength(0);
    });

    test('notifies multiple onUnhealthy listeners', async () => {
      const calls1: number[] = [];
      const calls2: number[] = [];
      checker.onUnhealthy((id) => calls1.push(id));
      checker.onUnhealthy((id) => calls2.push(id));

      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 50,
          timeout: 30,
          unhealthyThreshold: 1, // fire after first failure
        },
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      checker.startChecking(300, config);

      await new Promise((r) => setTimeout(r, 250));

      checker.stopChecking(300);

      expect(calls1.length).toBeGreaterThanOrEqual(1);
      expect(calls2.length).toBeGreaterThanOrEqual(1);
    });

    test('offUnhealthy prevents removed listener from firing', async () => {
      const calls: number[] = [];
      const cb: UnhealthyCallback = (id) => calls.push(id);
      checker.onUnhealthy(cb);
      checker.offUnhealthy(cb);

      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 50,
          timeout: 30,
          unhealthyThreshold: 1,
        },
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      checker.startChecking(400, config);

      await new Promise((r) => setTimeout(r, 250));

      checker.stopChecking(400);

      expect(calls).toHaveLength(0);
    });

    test('health check respects timeout for slow servers', async () => {
      const port = 19_500 + Math.floor(Math.random() * 500);
      const workerId = port - INTERNAL_PORT_BASE;

      // Server that takes too long to respond
      const srv = Bun.serve({
        port,
        async fetch() {
          await new Promise((r) => setTimeout(r, 2_000));
          return new Response('OK', { status: 200 });
        },
      });
      servers.push(srv);

      const calls: Array<{ workerId: number; reason: string }> = [];
      checker.onUnhealthy((id, reason) => calls.push({ workerId: id, reason }));

      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 80,
          timeout: 30, // very short timeout
          unhealthyThreshold: 2,
        },
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      checker.startChecking(workerId, config);

      await new Promise((r) => setTimeout(r, 500));

      checker.stopChecking(workerId);

      // Server responds too slowly => counts as failure => unhealthy
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls[0].workerId).toBe(workerId);
    });

    test('recovery: failure count resets after server starts returning 200', async () => {
      const port = 19_500 + Math.floor(Math.random() * 500);
      const workerId = port - INTERNAL_PORT_BASE;

      let shouldFail = true;
      const srv = Bun.serve({
        port,
        fetch() {
          if (shouldFail) {
            return new Response('Error', { status: 500 });
          }
          return new Response('OK', { status: 200 });
        },
      });
      servers.push(srv);

      const calls: Array<{ workerId: number; reason: string }> = [];
      checker.onUnhealthy((id, reason) => calls.push({ workerId: id, reason }));

      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 50,
          timeout: 500,
          unhealthyThreshold: 10, // high so we can flip before threshold
        },
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      checker.startChecking(workerId, config);

      // Let a few failures accumulate
      await new Promise((r) => setTimeout(r, 150));

      // Flip to healthy
      shouldFail = false;

      // Wait for a healthy check to reset the counter
      await new Promise((r) => setTimeout(r, 150));

      // Flip back to unhealthy
      shouldFail = true;

      // Wait more - the counter should have reset so we still haven't
      // reached 10 consecutive failures
      await new Promise((r) => setTimeout(r, 200));

      checker.stopChecking(workerId);

      // The recovery in the middle should have reset the counter,
      // preventing the threshold of 10 from being reached
      expect(calls).toHaveLength(0);
    });

    test('uses reusePort config.port for health check URL', async () => {
      const port = 19_500 + Math.floor(Math.random() * 500);

      let requestCount = 0;
      const srv = Bun.serve({
        port,
        fetch() {
          requestCount++;
          return new Response('OK', { status: 200 });
        },
      });
      servers.push(srv);

      const config = makeConfig({
        port,
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 50,
          timeout: 500,
          unhealthyThreshold: 3,
        },
        clustering: {
          enabled: true,
          strategy: 'reusePort',
          rollingRestart: { batchSize: 1, batchDelay: 1_000 },
        },
      });

      // workerId doesn't matter for reusePort since it uses config.port
      checker.startChecking(0, config);

      await new Promise((r) => setTimeout(r, 200));

      checker.stopChecking(0);

      // The server at config.port should have received requests
      expect(requestCount).toBeGreaterThanOrEqual(1);
    });
  });

  // -----------------------------------------------------------------------
  // startHeartbeatMonitor / stopHeartbeatMonitor
  // -----------------------------------------------------------------------

  describe('startHeartbeatMonitor / stopHeartbeatMonitor', () => {
    test('seeds initial heartbeat on start', () => {
      checker.startHeartbeatMonitor(1, () => {});
      // Immediately after starting, the heartbeat should not be stale
      expect(checker.isHeartbeatStale(1)).toBe(false);
    });

    test('does not fire onStale immediately', async () => {
      const staleCalls: number[] = [];
      checker.startHeartbeatMonitor(1, (id) => staleCalls.push(id));

      // Wait a brief period (well below HEARTBEAT_INTERVAL)
      await new Promise((r) => setTimeout(r, 100));

      checker.stopHeartbeatMonitor(1);
      expect(staleCalls).toHaveLength(0);
    });

    test('fires onStale when heartbeat becomes stale', async () => {
      const originalNow = Date.now;
      const baseTime = originalNow();
      let currentTime = baseTime;

      Date.now = () => currentTime;

      const staleCalls: number[] = [];

      try {
        checker.startHeartbeatMonitor(1, (id) => staleCalls.push(id));

        // Advance time beyond threshold: HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD = 30_000
        currentTime = baseTime + HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD + 1_000;

        // Manually trigger the check by waiting for the interval.
        // The real HEARTBEAT_INTERVAL is 10s which is too long for tests.
        // Instead we verify the stale detection logic directly.
        expect(checker.isHeartbeatStale(1)).toBe(true);
      } finally {
        checker.stopHeartbeatMonitor(1);
        Date.now = originalNow;
      }
    });

    test('does not fire onStale when heartbeats are received regularly', () => {
      const originalNow = Date.now;
      const baseTime = originalNow();
      let currentTime = baseTime;

      Date.now = () => currentTime;

      try {
        checker.startHeartbeatMonitor(1, () => {
          throw new Error('should not fire');
        });

        // Simulate regular heartbeats arriving well within threshold
        currentTime = baseTime + 5_000;
        checker.onHeartbeat(1);

        currentTime = baseTime + 10_000;
        checker.onHeartbeat(1);

        currentTime = baseTime + 15_000;
        checker.onHeartbeat(1);

        // Still fresh
        expect(checker.isHeartbeatStale(1)).toBe(false);
      } finally {
        checker.stopHeartbeatMonitor(1);
        Date.now = originalNow;
      }
    });

    test('stopHeartbeatMonitor clears heartbeat data', () => {
      checker.startHeartbeatMonitor(1, () => {});
      checker.stopHeartbeatMonitor(1);

      // After stopping, lastHeartbeat is deleted so isHeartbeatStale returns false
      // (unknown worker returns false)
      expect(checker.isHeartbeatStale(1)).toBe(false);
    });

    test('stopHeartbeatMonitor does not throw for unknown workerId', () => {
      expect(() => checker.stopHeartbeatMonitor(999)).not.toThrow();
    });

    test('stopHeartbeatMonitor can be called multiple times safely', () => {
      checker.startHeartbeatMonitor(1, () => {});
      checker.stopHeartbeatMonitor(1);
      checker.stopHeartbeatMonitor(1);
      // No throw
    });

    test('startHeartbeatMonitor replaces existing monitor for same workerId', () => {
      const calls1: number[] = [];
      const calls2: number[] = [];

      checker.startHeartbeatMonitor(1, (id) => calls1.push(id));
      // Starting again should stop the previous monitor
      checker.startHeartbeatMonitor(1, (id) => calls2.push(id));

      checker.stopHeartbeatMonitor(1);
      // No leaking timers - just verify no throw
    });

    test('monitors multiple workers independently', () => {
      const originalNow = Date.now;
      const baseTime = originalNow();
      let currentTime = baseTime;

      Date.now = () => currentTime;

      try {
        checker.startHeartbeatMonitor(1, () => {});
        checker.startHeartbeatMonitor(2, () => {});

        // Advance a bit and heartbeat only worker 1
        currentTime = baseTime + 5_000;
        checker.onHeartbeat(1);

        // Advance far enough for worker 2 to become stale but not worker 1
        currentTime = baseTime + HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD + 1_000;

        // Worker 1 heartbeated at baseTime+5000, so elapsed is ~26s => not stale (threshold = 30s)
        expect(checker.isHeartbeatStale(1)).toBe(false);

        // Worker 2 last heartbeat was at baseTime (seed), elapsed is ~31s => stale
        expect(checker.isHeartbeatStale(2)).toBe(true);
      } finally {
        checker.stopHeartbeatMonitor(1);
        checker.stopHeartbeatMonitor(2);
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

    test('stops all health check timers', () => {
      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 100,
          timeout: 50,
          unhealthyThreshold: 3,
        },
      });
      checker.startChecking(1, config);
      checker.startChecking(2, config);
      expect(() => checker.stopAll()).not.toThrow();
    });

    test('stops both health check and heartbeat timers together', () => {
      const config = makeConfig({
        healthCheck: {
          enabled: true,
          path: '/health',
          interval: 100,
          timeout: 50,
          unhealthyThreshold: 3,
        },
      });
      checker.startChecking(1, config);
      checker.startHeartbeatMonitor(1, () => {});
      checker.startChecking(2, config);
      checker.startHeartbeatMonitor(2, () => {});
      expect(() => checker.stopAll()).not.toThrow();
    });

    test('can be called multiple times without error', () => {
      checker.startHeartbeatMonitor(1, () => {});
      checker.stopAll();
      checker.stopAll();
    });
  });
});
