// ---------------------------------------------------------------------------
// bunpm2 – Prometheus formatter unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { formatPrometheus, type AppMetricsInput } from '../../src/metrics/prometheus';

function makeApp(name: string, overrides: Partial<AppMetricsInput> = {}): AppMetricsInput {
  return {
    appName: name,
    workers: [
      {
        workerId: 0,
        metrics: {
          memory: {
            rss: 52_428_800,
            heapTotal: 30_000_000,
            heapUsed: 20_000_000,
            external: 500_000,
          },
          cpuPercent: 12.3,
          timestamp: Date.now(),
        },
        restartCount: 2,
        uptime: 3600.5,
        state: 'online',
      },
    ],
    ...overrides,
  };
}

describe('formatPrometheus', () => {
  test('output contains HELP and TYPE headers', () => {
    const output = formatPrometheus([makeApp('my-app')]);
    expect(output).toContain('# HELP bunpm2_worker_memory_rss_bytes');
    expect(output).toContain('# TYPE bunpm2_worker_memory_rss_bytes gauge');
    expect(output).toContain('# HELP bunpm2_worker_cpu_percent');
    expect(output).toContain('# TYPE bunpm2_worker_cpu_percent gauge');
  });

  test('output contains bunpm2_worker_memory_rss_bytes metric with correct value', () => {
    const output = formatPrometheus([makeApp('my-app')]);
    expect(output).toContain('bunpm2_worker_memory_rss_bytes{app="my-app",worker="0"} 52428800');
  });

  test('output contains bunpm2_worker_cpu_percent metric', () => {
    const output = formatPrometheus([makeApp('my-app')]);
    expect(output).toContain('bunpm2_worker_cpu_percent{app="my-app",worker="0"} 12.3');
  });

  test('output contains bunpm2_app_workers_online metric', () => {
    const output = formatPrometheus([makeApp('my-app')]);
    expect(output).toContain('bunpm2_app_workers_online{app="my-app"} 1');
  });

  test('output contains bunpm2_master_uptime_seconds metric', () => {
    const output = formatPrometheus([makeApp('my-app')]);
    expect(output).toContain('# HELP bunpm2_master_uptime_seconds');
    expect(output).toContain('# TYPE bunpm2_master_uptime_seconds gauge');
    expect(output).toMatch(/bunpm2_master_uptime_seconds \d+/);
  });

  test('label values with special characters are escaped', () => {
    const output = formatPrometheus([makeApp('my "special"\napp')]);
    // Quotes should be escaped as \"
    expect(output).toContain('my \\"special\\"');
    // Newlines should be escaped as \\n
    expect(output).toContain('\\n');
    expect(output).not.toContain('\napp"');
  });

  test('empty apps array produces only master metrics', () => {
    const output = formatPrometheus([]);
    // Should still have master uptime
    expect(output).toContain('bunpm2_master_uptime_seconds');
    // Should not have any worker-level metric values (headers are still present)
    expect(output).not.toContain('worker="');
  });

  test('errored workers are counted in bunpm2_app_workers_errored', () => {
    const app = makeApp('crash-app', {
      workers: [
        {
          workerId: 0,
          metrics: null,
          restartCount: 5,
          uptime: 0,
          state: 'errored',
        },
        {
          workerId: 1,
          metrics: null,
          restartCount: 0,
          uptime: 100,
          state: 'online',
        },
      ],
    });
    const output = formatPrometheus([app]);
    expect(output).toContain('bunpm2_app_workers_errored{app="crash-app"} 1');
    expect(output).toContain('bunpm2_app_workers_online{app="crash-app"} 1');
  });

  test('workers with null metrics emit restarts and uptime but skip memory/cpu', () => {
    const app = makeApp('no-metrics-app', {
      workers: [
        {
          workerId: 0,
          metrics: null,
          restartCount: 3,
          uptime: 10,
          state: 'starting',
        },
      ],
    });
    const output = formatPrometheus([app]);
    expect(output).toContain('bunpm2_worker_restarts_total{app="no-metrics-app",worker="0"} 3');
    expect(output).toContain('bunpm2_worker_uptime_seconds{app="no-metrics-app",worker="0"} 10');
    // Memory and CPU lines should not appear for this worker
    expect(output).not.toContain('bunpm2_worker_memory_rss_bytes{app="no-metrics-app"');
    expect(output).not.toContain('bunpm2_worker_cpu_percent{app="no-metrics-app"');
  });
});
