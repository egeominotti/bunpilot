// ---------------------------------------------------------------------------
// bunpm – Unit Tests for ReusePortCluster
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { ReusePortCluster } from '../../src/cluster/reuse-port';

// ---------------------------------------------------------------------------
// getWorkerEnv
// ---------------------------------------------------------------------------

describe('ReusePortCluster', () => {
  const cluster = new ReusePortCluster();

  describe('getWorkerEnv', () => {
    test('returns BUNPM_PORT as a string of the given port', () => {
      const env = cluster.getWorkerEnv(1, 3000);
      expect(env.BUNPM_PORT).toBe('3000');
    });

    test('returns BUNPM_REUSE_PORT set to "1"', () => {
      const env = cluster.getWorkerEnv(1, 3000);
      expect(env.BUNPM_REUSE_PORT).toBe('1');
    });

    test('returns an object with exactly two keys', () => {
      const env = cluster.getWorkerEnv(5, 8080);
      expect(Object.keys(env)).toHaveLength(2);
    });

    test('uses the correct port for different values', () => {
      const env = cluster.getWorkerEnv(2, 9090);
      expect(env.BUNPM_PORT).toBe('9090');
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle no-ops
  // -----------------------------------------------------------------------

  describe('addWorker', () => {
    test('does not throw', () => {
      expect(() => cluster.addWorker(1)).not.toThrow();
    });
  });

  describe('removeWorker', () => {
    test('does not throw', () => {
      expect(() => cluster.removeWorker(1)).not.toThrow();
    });
  });

  describe('stop', () => {
    test('does not throw', () => {
      expect(() => cluster.stop()).not.toThrow();
    });
  });
});
