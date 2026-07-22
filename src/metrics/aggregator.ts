// ---------------------------------------------------------------------------
// bunpilot – Per-worker metrics aggregation
// ---------------------------------------------------------------------------

import type { WorkerMetricsPayload } from '../config/types';
import type { WorkerMetricsData } from './prometheus';

interface WorkerSample {
  cpuTotalMicros: number;
  metrics: WorkerMetricsData;
}

/**
 * Retains the latest sample for each worker and derives CPU usage from
 * successive cumulative process.cpuUsage() counters.
 */
export class MetricsAggregator {
  private readonly samples = new Map<number, WorkerSample>();

  updateMetrics(
    workerId: number,
    payload: WorkerMetricsPayload,
    timestamp: number = Date.now(),
  ): WorkerMetricsData {
    const previous = this.samples.get(workerId);
    const cpuTotalMicros = payload.cpu.user + payload.cpu.system;
    const elapsedMicros = previous ? (timestamp - previous.metrics.timestamp) * 1_000 : 0;
    const deltaMicros = previous ? cpuTotalMicros - previous.cpuTotalMicros : 0;
    const cpuPercent =
      elapsedMicros > 0 && deltaMicros >= 0 ? (deltaMicros / elapsedMicros) * 100 : 0;

    const metrics: WorkerMetricsData = {
      memory: { ...payload.memory },
      cpuPercent,
      timestamp,
      ...(payload.eventLoopLag === undefined ? {} : { eventLoopLag: payload.eventLoopLag }),
      ...(payload.activeHandles === undefined ? {} : { activeHandles: payload.activeHandles }),
      ...(payload.custom === undefined ? {} : { custom: { ...payload.custom } }),
    };

    this.samples.set(workerId, { cpuTotalMicros, metrics });
    return this.clone(metrics);
  }

  getMetrics(workerId: number): WorkerMetricsData | null {
    const sample = this.samples.get(workerId);
    return sample ? this.clone(sample.metrics) : null;
  }

  removeWorker(workerId: number): void {
    this.samples.delete(workerId);
  }

  clear(): void {
    this.samples.clear();
  }

  private clone(metrics: WorkerMetricsData): WorkerMetricsData {
    return {
      ...metrics,
      memory: { ...metrics.memory },
      ...(metrics.custom === undefined ? {} : { custom: { ...metrics.custom } }),
    };
  }
}
