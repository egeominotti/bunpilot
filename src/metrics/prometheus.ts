// ---------------------------------------------------------------------------
// bunpm2 – Prometheus Exposition Format
// ---------------------------------------------------------------------------

import type { WorkerState } from '../config/types';
import type { WorkerMetricsData } from './aggregator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppMetricsInput {
  appName: string;
  workers: AppWorkerMetrics[];
}

export interface AppWorkerMetrics {
  workerId: number;
  metrics: WorkerMetricsData | null;
  restartCount: number;
  uptime: number;
  state: WorkerState;
}

// ---------------------------------------------------------------------------
// Metric descriptors
// ---------------------------------------------------------------------------

interface MetricDescriptor {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
}

const PER_WORKER_METRICS: MetricDescriptor[] = [
  {
    name: 'bunpm2_worker_memory_rss_bytes',
    help: 'Resident set size of the worker process in bytes',
    type: 'gauge',
  },
  {
    name: 'bunpm2_worker_memory_heap_used_bytes',
    help: 'V8 heap memory used by the worker process in bytes',
    type: 'gauge',
  },
  {
    name: 'bunpm2_worker_cpu_percent',
    help: 'CPU usage of the worker process as a percentage',
    type: 'gauge',
  },
  {
    name: 'bunpm2_worker_restarts_total',
    help: 'Total number of restarts for the worker',
    type: 'counter',
  },
  {
    name: 'bunpm2_worker_uptime_seconds',
    help: 'Uptime of the worker process in seconds',
    type: 'gauge',
  },
];

const PER_APP_METRICS: MetricDescriptor[] = [
  {
    name: 'bunpm2_app_workers_online',
    help: 'Number of workers in online state',
    type: 'gauge',
  },
  {
    name: 'bunpm2_app_workers_errored',
    help: 'Number of workers in errored state',
    type: 'gauge',
  },
];

const MASTER_METRICS: MetricDescriptor[] = [
  {
    name: 'bunpm2_master_uptime_seconds',
    help: 'Uptime of the bunpm2 master process in seconds',
    type: 'gauge',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape label values for Prometheus text format. */
function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Render a single metric line with labels. */
function metricLine(name: string, labels: Record<string, string>, value: number): string {
  const pairs = Object.entries(labels)
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`)
    .join(',');
  return `${name}{${pairs}} ${value}`;
}

/** Render the HELP + TYPE header block for a metric family. */
function metricHeader(desc: MetricDescriptor): string {
  return `# HELP ${desc.name} ${desc.help}\n# TYPE ${desc.name} ${desc.type}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Format application metrics into the Prometheus text exposition format.
 *
 * @param apps  Array of per-app metric inputs.
 * @returns     Multi-line string ready to serve on `/metrics`.
 */
export function formatPrometheus(apps: AppMetricsInput[]): string {
  const lines: string[] = [];

  // -- Per-worker metrics ---------------------------------------------------
  for (const desc of PER_WORKER_METRICS) {
    lines.push(metricHeader(desc));

    for (const app of apps) {
      for (const w of app.workers) {
        const labels = {
          app: app.appName,
          worker: String(w.workerId),
        };

        const value = workerMetricValue(desc.name, w);
        if (value !== null) {
          lines.push(metricLine(desc.name, labels, value));
        }
      }
    }

    lines.push('');
  }

  // -- Per-app metrics ------------------------------------------------------
  for (const desc of PER_APP_METRICS) {
    lines.push(metricHeader(desc));

    for (const app of apps) {
      const labels = { app: app.appName };
      const value = appMetricValue(desc.name, app);
      lines.push(metricLine(desc.name, labels, value));
    }

    lines.push('');
  }

  // -- Master metrics -------------------------------------------------------
  for (const desc of MASTER_METRICS) {
    lines.push(metricHeader(desc));
    const uptimeSeconds = parseFloat(process.uptime().toFixed(1));
    lines.push(`${desc.name} ${uptimeSeconds}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Value extractors
// ---------------------------------------------------------------------------

function workerMetricValue(metricName: string, worker: AppWorkerMetrics): number | null {
  switch (metricName) {
    case 'bunpm2_worker_memory_rss_bytes':
      return worker.metrics?.memory.rss ?? null;

    case 'bunpm2_worker_memory_heap_used_bytes':
      return worker.metrics?.memory.heapUsed ?? null;

    case 'bunpm2_worker_cpu_percent':
      return worker.metrics ? parseFloat(worker.metrics.cpuPercent.toFixed(1)) : null;

    case 'bunpm2_worker_restarts_total':
      return worker.restartCount;

    case 'bunpm2_worker_uptime_seconds':
      return parseFloat(worker.uptime.toFixed(1));

    default:
      return null;
  }
}

function appMetricValue(metricName: string, app: AppMetricsInput): number {
  switch (metricName) {
    case 'bunpm2_app_workers_online':
      return app.workers.filter((w) => w.state === 'online').length;

    case 'bunpm2_app_workers_errored':
      return app.workers.filter((w) => w.state === 'errored' || w.state === 'crashed').length;

    default:
      return 0;
  }
}
