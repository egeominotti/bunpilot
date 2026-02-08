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
  workers: { port: number; alive: boolean }[];
  rrIndex: number;
  nextAliveWorker: () => { port: number; alive: boolean } | null;
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
  };
}

/**
 * Initialise the proxy's worker slots without starting a TCP listener.
 * This mirrors the slot-creation logic from `ProxyCluster.start()`.
 */
function initWorkerSlots(proxy: ProxyCluster, count: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = proxy as any;
  p.workers = Array.from({ length: count }, (_, i) => ({
    port: INTERNAL_PORT_BASE + i,
    alive: false,
  }));
  p.rrIndex = 0;
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
      expect(internals.workers).toEqual([]);
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
      expect(internals.workers.length).toBe(4);
    });

    test('worker ports are based on INTERNAL_PORT_BASE', () => {
      initWorkerSlots(proxy, 3);
      const internals = getInternals(proxy);
      expect(internals.workers[0].port).toBe(INTERNAL_PORT_BASE);
      expect(internals.workers[1].port).toBe(INTERNAL_PORT_BASE + 1);
      expect(internals.workers[2].port).toBe(INTERNAL_PORT_BASE + 2);
    });

    test('all workers start as not alive', () => {
      initWorkerSlots(proxy, 3);
      const internals = getInternals(proxy);
      for (const w of internals.workers) {
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
      expect(internals.workers[1].alive).toBe(true);
    });

    test('does not affect other workers', () => {
      initWorkerSlots(proxy, 3);
      proxy.addWorker(1);
      const internals = getInternals(proxy);
      expect(internals.workers[0].alive).toBe(false);
      expect(internals.workers[2].alive).toBe(false);
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
      expect(getInternals(proxy).workers[1].alive).toBe(true);

      proxy.removeWorker(1);
      expect(getInternals(proxy).workers[1].alive).toBe(false);
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
      expect(internals.workers).toEqual([]);
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
  });
});
