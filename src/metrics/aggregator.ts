// ---------------------------------------------------------------------------
// bunpm – Metrics Aggregator
// ---------------------------------------------------------------------------

import type { WorkerMetricsPayload } from '../config/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkerMetricsData {
  memory: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
  };
  cpuPercent: number;
  eventLoopLag?: number;
  activeHandles?: number;
  timestamp: number;
  custom?: Record<string, number>;
}

interface CpuSnapshot {
  user: number;
  system: number;
  time: number;
}

// ---------------------------------------------------------------------------
// MetricsAggregator
// ---------------------------------------------------------------------------

export class MetricsAggregator {
  private workerMetrics: Map<number, WorkerMetricsData> = new Map();
  private previousCpu: Map<number, CpuSnapshot> = new Map();

  /**
   * Ingest a metrics payload from a worker, computing CPU % from
   * the delta between the current and previous cpu snapshots.
   *
   * CPU values in the payload are in **microseconds**.
   * Formula: `((userDelta + systemDelta) / 1000) / elapsedMs * 100`
   */
  updateMetrics(workerId: number, payload: WorkerMetricsPayload): void {
    const now = Date.now();
    const cpuPercent = this.computeCpuPercent(workerId, payload.cpu, now);

    const data: WorkerMetricsData = {
      memory: {
        rss: payload.memory.rss,
        heapTotal: payload.memory.heapTotal,
        heapUsed: payload.memory.heapUsed,
        external: payload.memory.external,
      },
      cpuPercent,
      timestamp: now,
    };

    if (payload.eventLoopLag !== undefined) {
      data.eventLoopLag = payload.eventLoopLag;
    }
    if (payload.activeHandles !== undefined) {
      data.activeHandles = payload.activeHandles;
    }
    if (payload.custom !== undefined) {
      data.custom = { ...payload.custom };
    }

    this.workerMetrics.set(workerId, data);
  }

  /** Retrieve latest metrics for a single worker. */
  getMetrics(workerId: number): WorkerMetricsData | null {
    return this.workerMetrics.get(workerId) ?? null;
  }

  /** Retrieve latest metrics for every tracked worker. */
  getAllMetrics(): Map<number, WorkerMetricsData> {
    return this.workerMetrics;
  }

  /** Remove all data associated with a worker. */
  removeWorker(workerId: number): void {
    this.workerMetrics.delete(workerId);
    this.previousCpu.delete(workerId);
  }

  /** Clear all stored data. */
  reset(): void {
    this.workerMetrics.clear();
    this.previousCpu.clear();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Compute CPU percentage from the delta between the previous and current
   * cpu usage values. Returns 0 on the first sample (no delta available).
   */
  private computeCpuPercent(
    workerId: number,
    cpu: { user: number; system: number },
    now: number,
  ): number {
    const prev = this.previousCpu.get(workerId);

    // Store the current snapshot for the next delta.
    this.previousCpu.set(workerId, {
      user: cpu.user,
      system: cpu.system,
      time: now,
    });

    if (!prev) {
      return 0;
    }

    const elapsedMs = now - prev.time;
    if (elapsedMs <= 0) {
      return 0;
    }

    const userDelta = cpu.user - prev.user;
    const systemDelta = cpu.system - prev.system;
    const cpuMs = (userDelta + systemDelta) / 1000; // microseconds -> ms
    const percent = (cpuMs / elapsedMs) * 100;

    // Clamp to 1 decimal and avoid negative values from counter resets.
    return Math.max(0, parseFloat(percent.toFixed(1)));
  }
}
