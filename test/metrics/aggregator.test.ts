// ---------------------------------------------------------------------------
// bunpm – MetricsAggregator unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import { MetricsAggregator } from '../../src/metrics/aggregator';

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    memory: {
      rss: 50_000_000,
      heapTotal: 30_000_000,
      heapUsed: 20_000_000,
      external: 1_000_000,
    },
    cpu: { user: 100_000, system: 50_000 },
    ...overrides,
  };
}

describe('MetricsAggregator', () => {
  let agg: MetricsAggregator;

  beforeEach(() => {
    agg = new MetricsAggregator();
  });

  test('updateMetrics stores worker data retrievable via getMetrics', () => {
    agg.updateMetrics(1, makePayload());
    const data = agg.getMetrics(1);
    expect(data).not.toBeNull();
    expect(data!.memory.rss).toBe(50_000_000);
    expect(data!.memory.heapUsed).toBe(20_000_000);
  });

  test('getMetrics returns null for an unknown worker', () => {
    expect(agg.getMetrics(999)).toBeNull();
  });

  test('getAllMetrics returns all stored entries', () => {
    agg.updateMetrics(1, makePayload());
    agg.updateMetrics(2, makePayload());
    const all = agg.getAllMetrics();
    expect(all.size).toBe(2);
    expect(all.has(1)).toBe(true);
    expect(all.has(2)).toBe(true);
  });

  test('removeWorker removes a specific worker entry', () => {
    agg.updateMetrics(1, makePayload());
    agg.updateMetrics(2, makePayload());
    agg.removeWorker(1);
    expect(agg.getMetrics(1)).toBeNull();
    expect(agg.getMetrics(2)).not.toBeNull();
  });

  test('reset clears all entries', () => {
    agg.updateMetrics(1, makePayload());
    agg.updateMetrics(2, makePayload());
    agg.reset();
    expect(agg.getAllMetrics().size).toBe(0);
    expect(agg.getMetrics(1)).toBeNull();
  });

  test('first updateMetrics yields cpuPercent of 0 (no previous snapshot)', () => {
    agg.updateMetrics(1, makePayload());
    const data = agg.getMetrics(1);
    expect(data!.cpuPercent).toBe(0);
  });

  test('CPU percentage is computed correctly from two consecutive updates', () => {
    const originalNow = Date.now;
    const baseTime = originalNow();

    try {
      // First sample at baseTime
      Date.now = () => baseTime;
      agg.updateMetrics(1, makePayload({ cpu: { user: 100_000, system: 50_000 } }));

      // Second sample 1 second later
      // user delta = 200_000 - 100_000 = 100_000 us
      // system delta = 100_000 - 50_000 = 50_000 us
      // total delta = 150_000 us = 150 ms
      // elapsed = 1000 ms
      // percent = (150 / 1000) * 100 = 15.0%
      Date.now = () => baseTime + 1_000;
      agg.updateMetrics(1, makePayload({ cpu: { user: 200_000, system: 100_000 } }));

      const data = agg.getMetrics(1);
      expect(data!.cpuPercent).toBe(15.0);
    } finally {
      Date.now = originalNow;
    }
  });

  test('optional fields (eventLoopLag, activeHandles, custom) are stored when provided', () => {
    const payload = makePayload({
      eventLoopLag: 1.5,
      activeHandles: 42,
      custom: { requestsPerSec: 100 },
    });
    agg.updateMetrics(1, payload);
    const data = agg.getMetrics(1);
    expect(data!.eventLoopLag).toBe(1.5);
    expect(data!.activeHandles).toBe(42);
    expect(data!.custom).toEqual({ requestsPerSec: 100 });
  });

  test('optional fields are omitted when not in payload', () => {
    agg.updateMetrics(1, makePayload());
    const data = agg.getMetrics(1);
    expect(data!.eventLoopLag).toBeUndefined();
    expect(data!.activeHandles).toBeUndefined();
    expect(data!.custom).toBeUndefined();
  });
});
