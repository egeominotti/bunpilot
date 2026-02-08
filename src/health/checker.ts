// ---------------------------------------------------------------------------
// bunpm – Health Checker
// ---------------------------------------------------------------------------
//
// Periodically probes worker HTTP health endpoints and monitors IPC
// heartbeats.  When a worker is deemed unhealthy the checker fires a
// callback so the orchestrator can take corrective action (restart, etc.).
// ---------------------------------------------------------------------------

import type { AppConfig } from '../config/types';
import { INTERNAL_PORT_BASE, HEARTBEAT_INTERVAL, HEARTBEAT_MISS_THRESHOLD } from '../constants';

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

export type UnhealthyCallback = (workerId: number, reason: string) => void;

// ---------------------------------------------------------------------------
// HealthChecker
// ---------------------------------------------------------------------------

/**
 * Monitors worker health via two complementary mechanisms:
 *
 * 1. **HTTP health checks** – periodic `GET` requests to a configurable path.
 *    After `unhealthyThreshold` consecutive failures the worker is declared
 *    unhealthy.
 *
 * 2. **IPC heartbeat monitoring** – if a worker's heartbeat message hasn't
 *    been received for `HEARTBEAT_MISS_THRESHOLD` intervals it is considered
 *    stale.
 *
 * Uses a simple callback-registration pattern instead of Node's EventEmitter
 * to stay dependency-free.
 */
export class HealthChecker {
  // -----------------------------------------------------------------------
  // State maps (keyed by workerId)
  // -----------------------------------------------------------------------

  /** Consecutive HTTP health check failure counts. */
  private failureCounts: Map<number, number> = new Map();

  /** Periodic HTTP check timers. */
  private timers: Map<number, Timer> = new Map();

  /** Timestamps of the most recent heartbeat per worker. */
  private lastHeartbeat: Map<number, number> = new Map();

  /** Periodic heartbeat-monitor timers. */
  private heartbeatTimers: Map<number, Timer> = new Map();

  // -----------------------------------------------------------------------
  // Callback registration (typed, lightweight EventEmitter alternative)
  // -----------------------------------------------------------------------

  private unhealthyListeners: UnhealthyCallback[] = [];

  /** Register a listener that fires when any worker becomes unhealthy. */
  onUnhealthy(cb: UnhealthyCallback): void {
    this.unhealthyListeners.push(cb);
  }

  /** Remove a previously registered listener. */
  offUnhealthy(cb: UnhealthyCallback): void {
    this.unhealthyListeners = this.unhealthyListeners.filter((l) => l !== cb);
  }

  /** Notify all registered listeners. */
  private emitUnhealthy(workerId: number, reason: string): void {
    for (const cb of this.unhealthyListeners) {
      cb(workerId, reason);
    }
  }

  // -----------------------------------------------------------------------
  // Port resolution
  // -----------------------------------------------------------------------

  /**
   * Determine which port to probe for a given worker.
   *
   * - **reusePort** strategy: every worker binds to the public `config.port`.
   * - **proxy** strategy: each worker binds to `INTERNAL_PORT_BASE + workerId`.
   */
  getWorkerPort(workerId: number, config: AppConfig): number {
    const strategy = config.clustering?.strategy ?? 'auto';

    if (strategy === 'reusePort') {
      return config.port ?? INTERNAL_PORT_BASE + workerId;
    }

    // 'proxy' or 'auto' (auto resolves to proxy on non-Linux in practice)
    return INTERNAL_PORT_BASE + workerId;
  }

  // -----------------------------------------------------------------------
  // HTTP Health Checks
  // -----------------------------------------------------------------------

  /**
   * Start periodic HTTP health checking for `workerId`.
   *
   * A `GET` request is sent to `http://127.0.0.1:{port}{healthCheck.path}`
   * every `healthCheck.interval` ms.  On failure the failure counter is
   * incremented; on success it is reset to zero.  When the counter reaches
   * `unhealthyThreshold` the `'unhealthy'` callback fires.
   */
  startChecking(workerId: number, config: AppConfig): void {
    const hc = config.healthCheck;
    if (!hc || !hc.enabled) return;

    // Make sure we start clean.
    this.stopChecking(workerId);

    const port = this.getWorkerPort(workerId, config);
    const url = `http://127.0.0.1:${port}${hc.path}`;

    this.failureCounts.set(workerId, 0);

    const timer = setInterval(() => {
      this.performCheck(workerId, url, hc.timeout, hc.unhealthyThreshold);
    }, hc.interval);

    this.timers.set(workerId, timer);
  }

  /** Stop HTTP health checking for `workerId` and reset its counters. */
  stopChecking(workerId: number): void {
    const timer = this.timers.get(workerId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(workerId);
    }
    this.failureCounts.delete(workerId);
  }

  // -----------------------------------------------------------------------
  // IPC Heartbeat
  // -----------------------------------------------------------------------

  /** Record a heartbeat from `workerId`. */
  onHeartbeat(workerId: number): void {
    this.lastHeartbeat.set(workerId, Date.now());
  }

  /**
   * Returns `true` when the worker has missed `HEARTBEAT_MISS_THRESHOLD` or
   * more consecutive heartbeat windows (each window = `HEARTBEAT_INTERVAL` ms).
   */
  isHeartbeatStale(workerId: number): boolean {
    const last = this.lastHeartbeat.get(workerId);
    if (last === undefined) return false;

    const elapsed = Date.now() - last;
    return elapsed >= HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD;
  }

  /**
   * Start a periodic monitor that invokes `onStale` when `workerId`'s
   * heartbeat becomes stale.
   */
  startHeartbeatMonitor(workerId: number, onStale: (workerId: number) => void): void {
    this.stopHeartbeatMonitor(workerId);

    // Seed the last-heartbeat so the first check has a baseline.
    this.lastHeartbeat.set(workerId, Date.now());

    const timer = setInterval(() => {
      if (this.isHeartbeatStale(workerId)) {
        onStale(workerId);
      }
    }, HEARTBEAT_INTERVAL);

    this.heartbeatTimers.set(workerId, timer);
  }

  /** Stop the heartbeat monitor for `workerId`. */
  stopHeartbeatMonitor(workerId: number): void {
    const timer = this.heartbeatTimers.get(workerId);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(workerId);
    }
    this.lastHeartbeat.delete(workerId);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Stop all timers for every tracked worker. */
  stopAll(): void {
    const timerIds = [...this.timers.keys()];
    const hbIds = [...this.heartbeatTimers.keys()];
    for (const workerId of timerIds) {
      this.stopChecking(workerId);
    }
    for (const workerId of hbIds) {
      this.stopHeartbeatMonitor(workerId);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Execute a single HTTP health check.  Uses `fetch` with an
   * `AbortController` so the request is aborted if it exceeds `timeout` ms.
   */
  private async performCheck(
    workerId: number,
    url: string,
    timeout: number,
    threshold: number,
  ): Promise<void> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, { signal: controller.signal });

      if (res.ok) {
        // Success – reset the failure counter.
        this.failureCounts.set(workerId, 0);
      } else {
        this.recordFailure(workerId, threshold, `HTTP ${res.status}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      this.recordFailure(workerId, threshold, message);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /** Increment failure count and emit if threshold reached. */
  private recordFailure(workerId: number, threshold: number, reason: string): void {
    const count = (this.failureCounts.get(workerId) ?? 0) + 1;
    this.failureCounts.set(workerId, count);

    if (count >= threshold) {
      this.emitUnhealthy(workerId, `health check failed ${count} times: ${reason}`);
    }
  }
}
