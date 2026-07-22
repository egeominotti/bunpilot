import { describe, expect, test } from 'bun:test';
import { MetricsAggregator } from '../../src/metrics/aggregator';

const payload = (user: number, system: number = 0) => ({
  memory: { rss: 100, heapTotal: 80, heapUsed: 40, external: 5 },
  cpu: { user, system },
  custom: { queueDepth: 2 },
});

describe('MetricsAggregator', () => {
  test('stores a defensive copy of the latest sample', () => {
    const aggregator = new MetricsAggregator();
    const input = payload(100);
    const result = aggregator.updateMetrics(1, input, 1_000);

    input.memory.rss = 999;
    result.memory.rss = 888;

    expect(aggregator.getMetrics(1)?.memory.rss).toBe(100);
    expect(aggregator.getMetrics(99)).toBeNull();
  });

  test('computes CPU percentage from counter and wall-clock deltas', () => {
    const aggregator = new MetricsAggregator();
    expect(aggregator.updateMetrics(1, payload(100_000), 1_000).cpuPercent).toBe(0);

    // 50 ms of CPU over 100 ms of wall time = 50% of one logical core.
    expect(aggregator.updateMetrics(1, payload(150_000), 1_100).cpuPercent).toBe(50);
  });

  test('isolates workers and handles counter resets without negative values', () => {
    const aggregator = new MetricsAggregator();
    aggregator.updateMetrics(1, payload(100_000), 1_000);
    aggregator.updateMetrics(2, payload(500_000), 1_000);

    expect(aggregator.updateMetrics(1, payload(10), 1_100).cpuPercent).toBe(0);
    expect(aggregator.updateMetrics(2, payload(600_000), 1_100).cpuPercent).toBe(100);

    aggregator.removeWorker(1);
    expect(aggregator.getMetrics(1)).toBeNull();
    aggregator.clear();
    expect(aggregator.getMetrics(2)).toBeNull();
  });
});
