import { expect, test } from 'bun:test';
import type { WorkerState } from '../../src/config/types';
import {
  type AppMetricsInput,
  type AppWorkerMetrics,
  formatPrometheus,
} from '../../src/metrics/prometheus';

// ---------------------------------------------------------------------------
// Invariant under test
// ---------------------------------------------------------------------------
//
// A per-worker *liveness* gauge (rss, heap_used, cpu_percent, uptime_seconds)
// describes a running OS process. Once a worker reaches a terminal state
// ('stopped' | 'errored' | 'crashed') there is no process behind it, so the
// series must either disappear from the exposition or be distinguishable via a
// per-worker state/up series.
//
// Today `formatPrometheus` keys `workerMetricValue` only on the metric name and
// never on `w.state`, and nothing in the core ever nulls `worker.memory` /
// `worker.cpu` / `worker.startedAt` on stop. Result: dead workers keep
// exporting the last sampled rss/heap/cpu forever and an uptime that climbs
// monotonically, with no label to filter them out.
// ---------------------------------------------------------------------------

const LIVENESS_GAUGES = [
  'bunpilot_worker_memory_rss_bytes',
  'bunpilot_worker_memory_heap_used_bytes',
  'bunpilot_worker_cpu_percent',
  'bunpilot_worker_uptime_seconds',
] as const;

const ALL_STATES: WorkerState[] = [
  'spawning',
  'starting',
  'online',
  'draining',
  'stopping',
  'stopped',
  'errored',
  'crashed',
];

const DEAD_STATES: WorkerState[] = ['stopped', 'errored', 'crashed'];

/** Deterministic PRNG (mulberry32). */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeWorker(workerId: number, state: WorkerState, rng: () => number): AppWorkerMetrics {
  const hasSample = rng() < 0.85;
  return {
    workerId,
    state,
    restartCount: Math.floor(rng() * 5),
    uptime: rng() * 100000,
    metrics: hasSample
      ? {
          memory: {
            rss: Math.floor(rng() * 200_000_000) + 1,
            heapTotal: Math.floor(rng() * 100_000_000) + 1,
            heapUsed: Math.floor(rng() * 50_000_000) + 1,
            external: Math.floor(rng() * 1_000_000) + 1,
          },
          cpuPercent: rng() * 100,
          timestamp: Date.now(),
        }
      : null,
  };
}

/**
 * Does the exposition contain a sample line for `metric{app=..,worker=..}`?
 * Matches the exact label set emitted by `metricLine`, so a fixed version that
 * adds a `state` label would still be caught (the assertion is about the series
 * existing at all for a dead worker).
 */
function hasSeries(out: string, metric: string, app: string, workerId: number): boolean {
  const needle = `${metric}{app="${app}",worker="${workerId}"`;
  return out.split('\n').some((line) => line.startsWith(needle));
}

// ---------------------------------------------------------------------------
// 1. Minimal, explicit reproduction
// ---------------------------------------------------------------------------

test('does not export per-worker liveness gauges for a stopped worker', () => {
  const input: AppMetricsInput[] = [
    {
      appName: 'api',
      workers: [
        {
          workerId: 0,
          state: 'stopped',
          restartCount: 2,
          uptime: 86400,
          metrics: {
            memory: { rss: 52428800, heapTotal: 20000000, heapUsed: 12000000, external: 500000 },
            cpuPercent: 12.3,
            timestamp: Date.now(),
          },
        },
      ],
    },
  ];

  const out = formatPrometheus(input);

  expect(out).not.toContain('bunpilot_worker_memory_rss_bytes{app="api",worker="0"} 52428800');
  expect(out).not.toContain('bunpilot_worker_uptime_seconds{app="api",worker="0"} 86400');
  expect(out).not.toContain('bunpilot_worker_cpu_percent{app="api",worker="0"} 12.3');
});

// ---------------------------------------------------------------------------
// 2. Property: no liveness gauge for any terminal-state worker, ever
// ---------------------------------------------------------------------------

test('property: terminal-state workers never emit liveness gauges', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const rng = makeRng(seed);

    const appCount = 1 + Math.floor(rng() * 3);
    const apps: AppMetricsInput[] = [];
    for (let a = 0; a < appCount; a++) {
      const workerCount = 1 + Math.floor(rng() * 4);
      const workers: AppWorkerMetrics[] = [];
      for (let w = 0; w < workerCount; w++) {
        const state = ALL_STATES[Math.floor(rng() * ALL_STATES.length)]!;
        workers.push(makeWorker(w, state, rng));
      }
      apps.push({ appName: `app${a}`, workers });
    }

    // Guarantee at least one terminal-state worker in the batch.
    apps[0]!.workers[0]!.state = DEAD_STATES[seed % DEAD_STATES.length]!;

    const out = formatPrometheus(apps);

    for (const app of apps) {
      for (const w of app.workers) {
        if (!DEAD_STATES.includes(w.state)) continue;
        for (const metric of LIVENESS_GAUGES) {
          const present = hasSeries(out, metric, app.appName, w.workerId);
          if (present) {
            const offending = out
              .split('\n')
              .find((l) => l.startsWith(`${metric}{app="${app.appName}",worker="${w.workerId}"`));
            throw new Error(
              `seed=${seed}: worker ${app.appName}/${w.workerId} is in terminal state ` +
                `"${w.state}" but the exposition still carries a liveness gauge:\n  ${offending}`,
            );
          }
          expect(present).toBe(false);
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Frozen-sample / climbing-uptime consequence
// ---------------------------------------------------------------------------

test('a stopped worker uptime does not keep climbing across scrapes', () => {
  // Mirrors src/daemon/boot.ts `appStatusToMetricsInput`, which derives uptime
  // from `Date.now() - w.startedAt` and is never reset/cleared on stop.
  const startedAt = Date.now() - 60_000;

  const scrape = (): string =>
    formatPrometheus([
      {
        appName: 'api',
        workers: [
          {
            workerId: 0,
            state: 'stopped',
            restartCount: 0,
            uptime: (Date.now() - startedAt) / 1000,
            metrics: {
              memory: { rss: 52428800, heapTotal: 1, heapUsed: 1, external: 1 },
              cpuPercent: 0,
              timestamp: Date.now(),
            },
          },
        ],
      },
    ]);

  const readUptime = (out: string): number | null => {
    const line = out
      .split('\n')
      .find((l) => l.startsWith('bunpilot_worker_uptime_seconds{app="api",worker="0"'));
    if (!line) return null;
    return Number(line.slice(line.lastIndexOf(' ') + 1));
  };

  const first = readUptime(scrape());
  Bun.sleepSync(1100);
  const second = readUptime(scrape());

  // Correct behaviour: the series is absent for a dead worker (both null).
  // Buggy behaviour: it exists and grows by ~1.1s per scrape, forever.
  expect({ first, second }).toEqual({ first: null, second: null });
});
