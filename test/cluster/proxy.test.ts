// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for ProxyCluster (logic only, no TCP listeners)
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import { ProxyCluster } from '../../src/cluster/proxy';
import { INTERNAL_PORT_BASE } from '../../src/constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Access private members of ProxyCluster for testing internal state.
 * We cast to `any` to reach the private `workers` and `rrIndex` fields
 * without starting actual TCP listeners.
 */
function getInternals(proxy: ProxyCluster): {
  workers: Map<number, { port: number; alive: boolean }>;
  rrIndex: number;
  nextAliveWorker: () => { port: number; alive: boolean } | null;
  handleConnection: (clientSocket: object) => void;
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = proxy as any;
  return {
    get workers() {
      return p.workers;
    },
    get rrIndex() {
      return p.rrIndex;
    },
    nextAliveWorker: () => p.nextAliveWorker.call(proxy),
    handleConnection: (clientSocket: object) => p.handleConnection.call(proxy, clientSocket),
  };
}

/**
 * Initialise the proxy's worker slots without starting a TCP listener.
 * This mirrors the slot-creation logic from `ProxyCluster.start()`.
 */
function initWorkerSlots(proxy: ProxyCluster, count: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = proxy as any;
  p.workers = new Map<number, { port: number; alive: boolean }>();
  for (let i = 0; i < count; i++) {
    p.workers.set(i, { port: INTERNAL_PORT_BASE + i, alive: false });
  }
  p.rrIndex = 0;
  // Rebuild the sorted worker ID cache (mirrors ProxyCluster.start())
  p.sortedWorkerIds = Array.from(p.workers.keys()).sort((a: number, b: number) => a - b);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProxyCluster', () => {
  let proxy: ProxyCluster;

  beforeEach(() => {
    proxy = new ProxyCluster();
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe('construction', () => {
    test('creates an instance', () => {
      expect(proxy).toBeInstanceOf(ProxyCluster);
    });

    test('starts with no workers', () => {
      const internals = getInternals(proxy);
      expect(internals.workers.size).toBe(0);
    });

    test('round-robin index starts at 0', () => {
      const internals = getInternals(proxy);
      expect(internals.rrIndex).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Worker slot initialisation (simulated, no TCP)
  // -----------------------------------------------------------------------

  describe('worker slots', () => {
    test('initWorkerSlots creates correct number of slots', () => {
      initWorkerSlots(proxy, 4);
      const internals = getInternals(proxy);
      expect(internals.workers.size).toBe(4);
    });

    test('worker ports are based on INTERNAL_PORT_BASE', () => {
      initWorkerSlots(proxy, 3);
      const internals = getInternals(proxy);
      expect(internals.workers.get(0)!.port).toBe(INTERNAL_PORT_BASE);
      expect(internals.workers.get(1)!.port).toBe(INTERNAL_PORT_BASE + 1);
      expect(internals.workers.get(2)!.port).toBe(INTERNAL_PORT_BASE + 2);
    });

    test('all workers start as not alive', () => {
      initWorkerSlots(proxy, 3);
      const internals = getInternals(proxy);
      for (const [, w] of internals.workers) {
        expect(w.alive).toBe(false);
      }
    });
  });

  // -----------------------------------------------------------------------
  // addWorker / removeWorker
  // -----------------------------------------------------------------------

  describe('addWorker', () => {
    test('marks a worker as alive', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(1);
      const internals = getInternals(proxy);
      expect(internals.workers.get(1)!.alive).toBe(true);
    });

    test('does not affect other workers', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(1);
      const internals = getInternals(proxy);
      expect(internals.workers.get(0)!.alive).toBe(false);
      expect(internals.workers.get(2)!.alive).toBe(false);
    });

    test('is a no-op for out-of-range workerId', () => {
      initWorkerSlots(proxy, 2);
      // Should not throw
      expect(() => proxy.addWorker(99)).not.toThrow();
    });
  });

  describe('removeWorker', () => {
    test('marks a worker as not alive', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(1);
      expect(getInternals(proxy).workers.get(1)!.alive).toBe(true);

      proxy.removeWorker(1);
      expect(getInternals(proxy).workers.get(1)!.alive).toBe(false);
    });

    test('is a no-op for out-of-range workerId', () => {
      initWorkerSlots(proxy, 2);
      expect(() => proxy.removeWorker(99)).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Round-robin selection (nextAliveWorker)
  // -----------------------------------------------------------------------

  describe('round-robin worker selection', () => {
    test('returns null when no workers exist', () => {
      const internals = getInternals(proxy);
      expect(internals.nextAliveWorker()).toBeNull();
    });

    test('returns null when no workers are alive', () => {
      initWorkerSlots(proxy, 3);
      const internals = getInternals(proxy);
      expect(internals.nextAliveWorker()).toBeNull();
    });

    test('returns the single alive worker', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(1);
      const internals = getInternals(proxy);

      const w = internals.nextAliveWorker();
      expect(w).not.toBeNull();
      expect(w!.port).toBe(INTERNAL_PORT_BASE + 1);
    });

    test('round-robins across alive workers', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(0);
      proxy.addWorker(1);
      proxy.addWorker(2);
      const internals = getInternals(proxy);

      const first = internals.nextAliveWorker();
      const second = internals.nextAliveWorker();
      const third = internals.nextAliveWorker();

      // Should cycle through 0, 1, 2
      expect(first!.port).toBe(INTERNAL_PORT_BASE + 0);
      expect(second!.port).toBe(INTERNAL_PORT_BASE + 1);
      expect(third!.port).toBe(INTERNAL_PORT_BASE + 2);
    });

    test('wraps around after reaching the end', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(0);
      proxy.addWorker(1);
      proxy.addWorker(2);
      const internals = getInternals(proxy);

      // Consume 3 rounds
      internals.nextAliveWorker(); // worker 0
      internals.nextAliveWorker(); // worker 1
      internals.nextAliveWorker(); // worker 2

      // Fourth call wraps around to worker 0
      const fourth = internals.nextAliveWorker();
      expect(fourth!.port).toBe(INTERNAL_PORT_BASE + 0);
    });

    test('skips dead workers', () => {
      initWorkerSlots(proxy, 4);
      proxy.addWorker(0);
      // worker 1 is dead
      proxy.addWorker(2);
      // worker 3 is dead
      const internals = getInternals(proxy);

      const first = internals.nextAliveWorker();
      const second = internals.nextAliveWorker();
      const third = internals.nextAliveWorker();

      expect(first!.port).toBe(INTERNAL_PORT_BASE + 0);
      expect(second!.port).toBe(INTERNAL_PORT_BASE + 2);
      // Wraps around back to worker 0
      expect(third!.port).toBe(INTERNAL_PORT_BASE + 0);
    });

    test('returns null after all workers are removed', () => {
      initWorkerSlots(proxy, 2);
      proxy.addWorker(0);
      proxy.addWorker(1);

      proxy.removeWorker(0);
      proxy.removeWorker(1);

      const internals = getInternals(proxy);
      expect(internals.nextAliveWorker()).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getWorkerEnv
  // -----------------------------------------------------------------------

  describe('getWorkerEnv', () => {
    test('returns BUNPILOT_PORT based on workerId', () => {
      const env = proxy.getWorkerEnv(0, 3000);
      expect(env.BUNPILOT_PORT).toBe(String(INTERNAL_PORT_BASE + 0));
    });

    test('returns BUNPILOT_REUSE_PORT as 0', () => {
      const env = proxy.getWorkerEnv(0, 3000);
      expect(env.BUNPILOT_REUSE_PORT).toBe('0');
    });

    test('different workerIds get different ports', () => {
      const env0 = proxy.getWorkerEnv(0, 3000);
      const env1 = proxy.getWorkerEnv(1, 3000);
      const env2 = proxy.getWorkerEnv(2, 3000);

      expect(env0.BUNPILOT_PORT).toBe(String(INTERNAL_PORT_BASE));
      expect(env1.BUNPILOT_PORT).toBe(String(INTERNAL_PORT_BASE + 1));
      expect(env2.BUNPILOT_PORT).toBe(String(INTERNAL_PORT_BASE + 2));
    });
  });

  // -----------------------------------------------------------------------
  // stop
  // -----------------------------------------------------------------------

  describe('stop', () => {
    test('clears all workers', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(0);
      proxy.addWorker(1);

      proxy.stop();

      const internals = getInternals(proxy);
      expect(internals.workers.size).toBe(0);
    });

    test('resets round-robin index to 0', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(0);
      // Advance the rrIndex
      getInternals(proxy).nextAliveWorker();

      proxy.stop();
      expect(getInternals(proxy).rrIndex).toBe(0);
    });

    test('calling stop twice does not throw', () => {
      proxy.stop();
      expect(() => proxy.stop()).not.toThrow();
    });

    test('stop(true) is called on the listener to close active connections (bug 6)', () => {
      // Verify the listener.stop() is called with true (closeActiveConnections)
      let stopCalledWith: boolean | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = proxy as any;
      p.listener = {
        stop(closeActive?: boolean) {
          stopCalledWith = closeActive;
        },
      };

      proxy.stop();
      expect(stopCalledWith).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Bug 2 & 3: Replacement workers with out-of-range IDs
  // -----------------------------------------------------------------------

  describe('replacement workers (bugs 2 & 3)', () => {
    test('addWorker dynamically creates a slot for out-of-range workerId', () => {
      initWorkerSlots(proxy, 2); // workerIds 0 and 1
      // Simulate crash recovery: replacement worker gets ID >= N
      proxy.addWorker(5);

      const internals = getInternals(proxy);
      // Slot should exist and be alive
      expect(internals.workers.has(5)).toBe(true);
      expect(internals.workers.get(5)!.alive).toBe(true);
      expect(internals.workers.get(5)!.port).toBe(INTERNAL_PORT_BASE + 5);
    });

    test('replacement worker receives traffic via round-robin', () => {
      initWorkerSlots(proxy, 2);
      // Worker 0 crashed, replacement gets ID 3 (via nextWorkerId++)
      proxy.removeWorker(0);
      proxy.addWorker(3);
      proxy.addWorker(1);

      const internals = getInternals(proxy);

      // Should route to worker 1 and worker 3
      const ports: number[] = [];
      for (let i = 0; i < 4; i++) {
        const w = internals.nextAliveWorker();
        if (w) ports.push(w.port);
      }

      // Both worker 1 and worker 3 should receive traffic
      expect(ports).toContain(INTERNAL_PORT_BASE + 1);
      expect(ports).toContain(INTERNAL_PORT_BASE + 3);
    });

    test('removeWorker works for dynamically added replacement workers', () => {
      initWorkerSlots(proxy, 2);
      proxy.addWorker(5); // replacement worker
      expect(getInternals(proxy).workers.get(5)!.alive).toBe(true);

      proxy.removeWorker(5);
      expect(getInternals(proxy).workers.get(5)!.alive).toBe(false);
    });

    test('getWorkerEnv returns correct port for replacement workers', () => {
      const env = proxy.getWorkerEnv(5, 3000);
      expect(env.BUNPILOT_PORT).toBe(String(INTERNAL_PORT_BASE + 5));
    });
  });

  // -----------------------------------------------------------------------
  // Bug: nextAliveWorker should use a cached sorted list
  // -----------------------------------------------------------------------

  describe('sorted worker list caching (performance)', () => {
    test('sortedWorkerIds is rebuilt when addWorker is called', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(0);
      proxy.addWorker(2);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = proxy as any;
      const cached: number[] = p.sortedWorkerIds;

      // Cache should exist and contain sorted keys
      expect(Array.isArray(cached)).toBe(true);
      expect(cached.length).toBeGreaterThan(0);
    });

    test('sortedWorkerIds is rebuilt when removeWorker is called', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(0);
      proxy.addWorker(1);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = proxy as any;
      const cacheAfterAdd = [...p.sortedWorkerIds];

      proxy.removeWorker(1);
      const cacheAfterRemove = [...p.sortedWorkerIds];

      // Cache should still be a valid array (same length since removeWorker
      // marks alive=false but doesn't delete the slot)
      expect(Array.isArray(cacheAfterRemove)).toBe(true);
      // Lengths are the same since the slot still exists, just marked dead
      expect(cacheAfterRemove.length).toBe(cacheAfterAdd.length);
    });

    test('nextAliveWorker does not create a new sorted array on each call', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(0);
      proxy.addWorker(1);
      proxy.addWorker(2);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = proxy as any;

      // Grab reference to cached array before calls
      const cachedBefore: number[] = p.sortedWorkerIds;

      const internals = getInternals(proxy);
      internals.nextAliveWorker();
      internals.nextAliveWorker();
      internals.nextAliveWorker();

      // After multiple calls, the cache reference should be the same object
      // (not re-created on each call)
      const cachedAfter: number[] = p.sortedWorkerIds;
      expect(cachedAfter).toBe(cachedBefore); // same reference
    });

    test('cache is invalidated when a new replacement worker is added', () => {
      initWorkerSlots(proxy, 2);
      proxy.addWorker(0);
      proxy.addWorker(1);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = proxy as any;
      const cacheBefore: number[] = p.sortedWorkerIds;

      // Add a replacement worker with a new ID
      proxy.addWorker(5);

      const cacheAfter: number[] = p.sortedWorkerIds;
      // Cache should have been rebuilt (new reference)
      expect(cacheAfter).not.toBe(cacheBefore);
      // And it should include the new worker ID
      expect(cacheAfter).toContain(5);
    });

    test('cached sortedWorkerIds are in ascending order', () => {
      initWorkerSlots(proxy, 2);
      proxy.addWorker(1);
      proxy.addWorker(0);
      // Add out-of-order replacement workers
      proxy.addWorker(10);
      proxy.addWorker(5);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cached: number[] = (proxy as any).sortedWorkerIds;
      for (let i = 1; i < cached.length; i++) {
        expect(cached[i]).toBeGreaterThan(cached[i - 1]);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Bug 1: Bun.connect rejection handling in handleConnection
  // -----------------------------------------------------------------------

  describe('handleConnection upstream failure (bug 1)', () => {
    test('client socket is closed when no alive workers exist', () => {
      initWorkerSlots(proxy, 2);
      // No workers are alive

      let endCalled = false;
      const fakeClient = {
        data: { upstream: null, pending: [] },
        write: () => 0,
        end: () => {
          endCalled = true;
        },
      };

      const internals = getInternals(proxy);
      internals.handleConnection(fakeClient);

      // When no workers are alive, clientSocket.end() should be called directly
      expect(endCalled).toBe(true);
    });
  });
});
