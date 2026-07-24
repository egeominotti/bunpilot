// ---------------------------------------------------------------------------
// h43 — stale metrics for dead workers
// ---------------------------------------------------------------------------
//
// Invariant under test:
//   A per-worker metric SAMPLE must describe a LIVE process.
//   Once a worker's OS process is gone (state 'stopped' / 'errored'), the
//   exposition must stop emitting bunpilot_worker_memory_rss_bytes,
//   bunpilot_worker_memory_heap_used_bytes, bunpilot_worker_cpu_percent and
//   bunpilot_worker_uptime_seconds for that {app,worker} label pair.
//
//   Today formatPrometheus() ignores `state` for every per-worker gauge:
//   it emits the last-seen RSS forever (so a memory alert that fired before
//   `bunpilot stop` never clears) and emits an uptime that keeps growing for a
//   process that has not existed for hours — while
//   bunpilot_app_workers_online correctly reads 0 in the same scrape.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { WorkerState } from '../../src/config/types';
import {
  type AppMetricsInput,
  type AppWorkerMetrics,
  formatPrometheus,
} from '../../src/metrics/prometheus';

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

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

/** States where the OS process is definitively gone and will not come back. */
const DEAD_STATES = new Set<WorkerState>(['stopped', 'errored']);

/** Gauges that describe a live OS process — must be absent for dead workers. */
const LIVE_PROCESS_GAUGES = [
  'bunpilot_worker_memory_rss_bytes',
  'bunpilot_worker_memory_heap_used_bytes',
  'bunpilot_worker_cpu_percent',
  'bunpilot_worker_uptime_seconds',
];

function makeWorker(rng: () => number, workerId: number, state: WorkerState): AppWorkerMetrics {
  return {
    workerId,
    // A worker that ran at some point always carries a last-seen sample: the
    // master never nulls worker.memory / worker.cpu on stop.
    metrics: {
      memory: {
        rss: Math.floor(rng() * 500_000_000) + 1,
        heapTotal: Math.floor(rng() * 100_000_000) + 1,
        heapUsed: Math.floor(rng() * 100_000_000) + 1,
        external: Math.floor(rng() * 10_000_000) + 1,
      },
      cpuPercent: rng() * 100,
      timestamp: 1_700_000_000_000 + Math.floor(rng() * 1000),
    },
    restartCount: Math.floor(rng() * 5),
    // boot.ts computes (Date.now() - w.startedAt)/1000 for EVERY state, and
    // startedAt is never cleared on stop -> grows without bound.
    uptime: rng() * 100_000,
    state,
  };
}

/** Does the exposition contain `name{app="A",worker="N"} ...`? */
function hasSample(text: string, name: string, app: string, workerId: number): boolean {
  const needle = `${name}{app="${app}",worker="${workerId}"}`;
  return text.includes(needle);
}

// ---------------------------------------------------------------------------
// Property: no live-process gauge is exported for a dead worker
// ---------------------------------------------------------------------------

test('formatPrometheus never exports live-process gauges for stopped/errored workers', () => {
  const RUNS = 300;

  for (let seed = 1; seed <= RUNS; seed++) {
    const rng = makeRng(seed);

    const appCount = 1 + Math.floor(rng() * 3);
    const apps: AppMetricsInput[] = [];
    for (let a = 0; a < appCount; a++) {
      const appName = `app${a}`;
      const workerCount = 1 + Math.floor(rng() * 4);
      const workers: AppWorkerMetrics[] = [];
      for (let w = 0; w < workerCount; w++) {
        const state = ALL_STATES[Math.floor(rng() * ALL_STATES.length)] as WorkerState;
        workers.push(makeWorker(rng, w, state));
      }
      // Guarantee at least one dead worker so every seed exercises the property.
      if (!workers.some((w) => DEAD_STATES.has(w.state))) {
        workers[0] = { ...(workers[0] as AppWorkerMetrics), state: 'stopped' };
      }
      apps.push({ appName, workers });
    }

    const text = formatPrometheus(apps);

    for (const app of apps) {
      for (const w of app.workers) {
        for (const gauge of LIVE_PROCESS_GAUGES) {
          const present = hasSample(text, gauge, app.appName, w.workerId);

          if (DEAD_STATES.has(w.state)) {
            expect(
              `seed=${seed} app=${app.appName} worker=${w.workerId} state=${w.state} gauge=${gauge} exported=${present}`,
            ).toBe(
              `seed=${seed} app=${app.appName} worker=${w.workerId} state=${w.state} gauge=${gauge} exported=false`,
            );
          } else if (w.state === 'online') {
            // Guard against a "fix" that simply deletes the gauges outright.
            expect(
              `seed=${seed} app=${app.appName} worker=${w.workerId} state=online gauge=${gauge} exported=${present}`,
            ).toBe(
              `seed=${seed} app=${app.appName} worker=${w.workerId} state=online gauge=${gauge} exported=true`,
            );
          }
        }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Concrete regression: `bunpilot stop web` must clear the RSS alert and must
// not keep an uptime gauge climbing for a process that no longer exists.
// ---------------------------------------------------------------------------

test('a stopped worker pins neither its last RSS nor a growing uptime', () => {
  const stoppedWorker: AppWorkerMetrics = {
    workerId: 0,
    metrics: {
      memory: { rss: 111_000_000, heapTotal: 2, heapUsed: 3, external: 4 },
      cpuPercent: 5,
      timestamp: 1,
    },
    restartCount: 0,
    uptime: 9999,
    state: 'stopped',
  };

  const text = formatPrometheus([{ appName: 'web', workers: [stoppedWorker] }]);

  // The same scrape reports zero online workers — the exposition must agree.
  expect(text).toContain('bunpilot_app_workers_online{app="web"} 0');

  expect(text).not.toContain('bunpilot_worker_memory_rss_bytes{app="web",worker="0"}');
  expect(text).not.toContain('bunpilot_worker_uptime_seconds{app="web",worker="0"}');
  expect(text).not.toContain('bunpilot_worker_cpu_percent{app="web",worker="0"}');
});
