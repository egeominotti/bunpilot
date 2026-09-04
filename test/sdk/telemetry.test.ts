// ---------------------------------------------------------------------------
// bunpilot – Worker SDK deep-telemetry collector unit tests
// ---------------------------------------------------------------------------
//
// Exercises the live collector against the real Bun runtime and asserts the
// invariants every consumer downstream relies on: all fields finite, ratios in
// [0,1], the object-type census bounded, and GC deltas sign-correct.
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import {
  collectTelemetry,
  createTelemetryState,
  disposeTelemetryState,
  type TelemetrySnapshot,
} from '../../src/sdk/telemetry';

function assertFiniteNumbers(value: unknown, path: string): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} must be finite (got ${value})`).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      assertFiniteNumbers(v, `${path}[${i}]`);
    });
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) assertFiniteNumbers(v, `${path}.${k}`);
  }
}

function assertSnapshotInvariants(s: TelemetrySnapshot): void {
  assertFiniteNumbers(s, 'snapshot');

  // Heap — non-negative sizes, bounded census.
  expect(s.heap.heapSize).toBeGreaterThanOrEqual(0);
  expect(s.heap.heapSizeLimit).toBeGreaterThanOrEqual(0);
  expect(s.heap.arrayBuffers).toBeGreaterThanOrEqual(0);
  expect(s.heap.topObjectTypes.length).toBeLessThanOrEqual(15);
  expect(typeof s.heap.censusAvailable).toBe('boolean');
  expect(typeof s.heap.v8StatisticsAvailable).toBe('boolean');
  for (const entry of s.heap.topObjectTypes) {
    expect(typeof entry.type).toBe('string');
    expect(entry.count).toBeGreaterThanOrEqual(0);
  }
  // Census is sorted descending by count.
  for (let i = 1; i < s.heap.topObjectTypes.length; i++) {
    expect(s.heap.topObjectTypes[i - 1].count).toBeGreaterThanOrEqual(
      s.heap.topObjectTypes[i].count,
    );
  }

  // GC — heapGrowthBytes may be negative; the rest are non-negative; ratio in [0,1].
  expect(Number.isFinite(s.gc.heapGrowthBytes)).toBe(true);
  expect(s.gc.reclaimedBytes).toBeGreaterThanOrEqual(0);
  expect(s.gc.allocationRateBytesPerSec).toBeGreaterThanOrEqual(0);
  expect(s.gc.inferredCollections).toBeGreaterThanOrEqual(0);
  expect(s.gc.heapUtilization).toBeGreaterThanOrEqual(0);
  expect(s.gc.heapUtilization).toBeLessThanOrEqual(1);

  // Stack — non-negative lags, utilization in [0,1].
  expect(s.stack.eventLoopLagMs).toBeGreaterThanOrEqual(0);
  expect(s.stack.eventLoopLagMaxMs).toBeGreaterThanOrEqual(0);
  expect(s.stack.eventLoopUtilization).toBeGreaterThanOrEqual(0);
  expect(s.stack.eventLoopUtilization).toBeLessThanOrEqual(1);
  expect(s.stack.activeResources).toBeGreaterThanOrEqual(0);
  expect(s.stack.callStackDepth).toBeGreaterThanOrEqual(0);
}

describe('deep telemetry collector', () => {
  test('every sample satisfies the finiteness / range / bound invariants', async () => {
    const state = createTelemetryState();
    try {
      for (let i = 0; i < 6; i++) {
        // Churn the heap so growth and reclaim both occur across samples.
        let churn: unknown[] = [];
        for (let j = 0; j < 30_000; j++) churn.push({ j, s: `x${j}` });
        churn = [];
        await new Promise((r) => setTimeout(r, 30));
        assertSnapshotInvariants(collectTelemetry(state, true));
      }
    } finally {
      disposeTelemetryState(state);
    }
  });

  test('inferredCollections is monotonic non-decreasing across samples', async () => {
    const state = createTelemetryState();
    try {
      let previous = 0;
      for (let i = 0; i < 5; i++) {
        let churn: unknown[] = [];
        for (let j = 0; j < 40_000; j++) churn.push([j]);
        churn = [];
        await new Promise((r) => setTimeout(r, 20));
        const snap = collectTelemetry(state, true);
        expect(snap.gc.inferredCollections).toBeGreaterThanOrEqual(previous);
        previous = snap.gc.inferredCollections;
      }
    } finally {
      disposeTelemetryState(state);
    }
  });

  test('shallow mode explicitly marks runtime-specific statistics unavailable', () => {
    const state = createTelemetryState();
    try {
      const snap = collectTelemetry(state, false);
      expect(snap.heap.topObjectTypes.length).toBe(0);
      expect(snap.heap.heapSize).toBeGreaterThanOrEqual(0);
      expect(snap.heap.censusAvailable).toBe(false);
      expect(snap.heap.v8StatisticsAvailable).toBe(false);
      expect(snap.heap.objectCount).toBe(0);
      expect(snap.heap.heapSizeLimit).toBe(0);
      expect(snap.heap.mallocedMemory).toBe(0);
      expect(snap.heap.peakMallocedMemory).toBe(0);
      expect(snap.heap.nativeContexts).toBe(0);
      expect(snap.heap.detachedContexts).toBe(0);
      assertFiniteNumbers(snap, 'shallow');
    } finally {
      disposeTelemetryState(state);
    }
  });
});
