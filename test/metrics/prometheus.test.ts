// ---------------------------------------------------------------------------
// bunpilot – Prometheus formatter unit tests
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { type AppMetricsInput, formatPrometheus } from '../../src/metrics/prometheus';

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
    expect(output).toContain('# HELP bunpilot_worker_memory_rss_bytes');
    expect(output).toContain('# TYPE bunpilot_worker_memory_rss_bytes gauge');
    expect(output).toContain('# HELP bunpilot_worker_cpu_percent');
    expect(output).toContain('# TYPE bunpilot_worker_cpu_percent gauge');
  });

  test('output contains bunpilot_worker_memory_rss_bytes metric with correct value', () => {
    const output = formatPrometheus([makeApp('my-app')]);
    expect(output).toContain('bunpilot_worker_memory_rss_bytes{app="my-app",worker="0"} 52428800');
  });

  test('output contains bunpilot_worker_cpu_percent metric', () => {
    const output = formatPrometheus([makeApp('my-app')]);
    expect(output).toContain('bunpilot_worker_cpu_percent{app="my-app",worker="0"} 12.3');
  });

  test('output contains bunpilot_app_workers_online metric', () => {
    const output = formatPrometheus([makeApp('my-app')]);
    expect(output).toContain('bunpilot_app_workers_online{app="my-app"} 1');
  });

  test('output contains bunpilot_master_uptime_seconds metric', () => {
    const output = formatPrometheus([makeApp('my-app')]);
    expect(output).toContain('# HELP bunpilot_master_uptime_seconds');
    expect(output).toContain('# TYPE bunpilot_master_uptime_seconds gauge');
    expect(output).toMatch(/bunpilot_master_uptime_seconds \d+/);
  });

  test('label values with special characters are escaped', () => {
    const output = formatPrometheus([makeApp('my "special"\napp')]);
    // Quotes should be escaped as \"
    expect(output).toContain('my \\"special\\"');
    // Newlines should be escaped as \\n
    expect(output).toContain('\\n');
    expect(output).not.toContain('\napp"');
  });

  test('property: label escaping matches the Prometheus text rules', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        const expected = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
        const output = formatPrometheus([makeApp(name)]);
        expect(output).toContain(`{app="${expected}",worker="0"}`);
      }),
      { seed: 2_026_09_04, numRuns: 1_000 },
    );
  });

  test('ignores inherited enumerable properties when rendering labels', () => {
    Object.defineProperty(Object.prototype, 'inheritedPrometheusLabel', {
      configurable: true,
      enumerable: true,
      value: 'must-not-leak',
    });
    try {
      expect(formatPrometheus([makeApp('safe')])).not.toContain('inheritedPrometheusLabel');
    } finally {
      delete (Object.prototype as Record<string, unknown>).inheritedPrometheusLabel;
    }
  });

  test('omits unavailable runtime-specific heap series instead of reporting fake zeros', () => {
    const app = makeApp('shallow', {
      workers: [
        {
          workerId: 0,
          restartCount: 0,
          uptime: 1,
          state: 'online',
          metrics: {
            memory: { rss: 1, heapTotal: 2, heapUsed: 1, external: 0 },
            cpuPercent: 0,
            timestamp: 1,
            telemetry: {
              timestamp: 1,
              heap: {
                censusAvailable: false,
                v8StatisticsAvailable: false,
                heapSize: 1,
                heapCapacity: 2,
                extraMemory: 0,
                objectCount: 0,
                protectedObjectCount: 0,
                globalObjectCount: 0,
                usedHeapSize: 1,
                totalHeapSize: 2,
                heapSizeLimit: 0,
                mallocedMemory: 0,
                peakMallocedMemory: 0,
                nativeContexts: 0,
                detachedContexts: 0,
                arrayBuffers: 0,
                topObjectTypes: [],
              },
              gc: {
                heapGrowthBytes: 0,
                allocationRateBytesPerSec: 0,
                reclaimedBytes: 0,
                inferredCollections: 0,
                heapUtilization: 0.5,
                compileTimeMs: 0,
              },
              stack: {
                eventLoopLagMs: 0,
                eventLoopLagMaxMs: 0,
                eventLoopLagP99Ms: 0,
                eventLoopUtilization: 0,
                activeResources: 0,
                callStackDepth: 0,
              },
            },
          },
        },
      ],
    });

    const output = formatPrometheus([app]);
    expect(output).toContain('bunpilot_worker_heap_size_bytes{app="shallow",worker="0"} 1');
    expect(output).not.toContain('bunpilot_worker_heap_limit_bytes{app="shallow"');
    expect(output).not.toContain('bunpilot_worker_heap_object_count{app="shallow"');
    expect(output).not.toContain('bunpilot_worker_heap_native_contexts{app="shallow"');
    expect(output).not.toContain('bunpilot_worker_heap_detached_contexts{app="shallow"');
  });

  test('empty apps array produces only master metrics', () => {
    const output = formatPrometheus([]);
    // Should still have master uptime
    expect(output).toContain('bunpilot_master_uptime_seconds');
    // Should not have any worker-level metric values (headers are still present)
    expect(output).not.toContain('worker="');
  });

  test('errored workers are counted in bunpilot_app_workers_errored', () => {
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
    expect(output).toContain('bunpilot_app_workers_errored{app="crash-app"} 1');
    expect(output).toContain('bunpilot_app_workers_online{app="crash-app"} 1');
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
    expect(output).toContain('bunpilot_worker_restarts_total{app="no-metrics-app",worker="0"} 3');
    expect(output).toContain('bunpilot_worker_uptime_seconds{app="no-metrics-app",worker="0"} 10');
    // Memory and CPU lines should not appear for this worker
    expect(output).not.toContain('bunpilot_worker_memory_rss_bytes{app="no-metrics-app"');
    expect(output).not.toContain('bunpilot_worker_cpu_percent{app="no-metrics-app"');
  });
});
