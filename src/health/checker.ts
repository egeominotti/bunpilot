// ---------------------------------------------------------------------------
// bunpilot – Health Checker
// ---------------------------------------------------------------------------
//
// Periodically probes worker HTTP health endpoints and monitors IPC
// heartbeats.  When a worker is deemed unhealthy the checker fires a
// callback so the orchestrator can take corrective action (restart, etc.).
// ---------------------------------------------------------------------------

import { resolveWorkerPort } from '../cluster/policy';
import type { AppConfig } from '../config/types';
import { HEARTBEAT_INTERVAL, HEARTBEAT_MISS_THRESHOLD, INTERNAL_PORT_BASE } from '../constants';

// ---------------------------------------------------------------------------
// Callback types
// ---------------------------------------------------------------------------

export type UnhealthyCallback = (workerId: number, reason: string, namespace: string) => void;

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
  private failureCounts: Map<string, number> = new Map();

  /** Per-worker guard: true while an async performCheck is in-flight. */
  private checking: Map<string, boolean> = new Map();

  /** Periodic HTTP check timers. */
  private timers: Map<string, Timer> = new Map();

  /** Identity token for the active HTTP monitor generation. */
  private checkTokens: Map<string, symbol> = new Map();

  /** Abort the in-flight request when a monitor is stopped or replaced. */
  private controllers: Map<string, AbortController> = new Map();

  /** Timestamps of the most recent *genuine* heartbeat per worker. */
  private lastHeartbeat: Map<string, number> = new Map();

  /** When heartbeat monitoring began per worker (the grace-period baseline). */
  private monitorStartedAt: Map<string, number> = new Map();

  /** Periodic heartbeat-monitor timers. */
  private heartbeatTimers: Map<string, Timer> = new Map();

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
  private emitUnhealthy(workerId: number, reason: string, namespace: string): void {
    for (const cb of this.unhealthyListeners) {
      cb(workerId, reason, namespace);
    }
  }

  // -----------------------------------------------------------------------
  // Port resolution
  // -----------------------------------------------------------------------

  /**
   * Determine which port to probe for a given worker.
   *
   * Delegates to the shared `resolveWorkerPort` policy so it always agrees with
   * the port the worker actually bound (`ProcessManager.buildEnv`). The previous
   * implementation only special-cased the literal `'reusePort'` and missed
   * `'auto'` (which on Linux resolves to reusePort and binds `config.port`),
   * causing the checker to probe a dead internal port and restart-loop healthy
   * workers. When no port is bound (degenerate clustered-without-port case)
   * there is nothing meaningful to probe, so we fall back to the internal port.
   */
  getWorkerPort(workerId: number, config: AppConfig): number {
    return resolveWorkerPort(config, workerId) ?? INTERNAL_PORT_BASE + workerId;
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
  startChecking(
    workerId: number,
    config: AppConfig,
    namespace: string = '',
    portOverride?: number,
  ): void {
    const hc = config.healthCheck;
    if (!hc?.enabled) return;

    // Make sure we start clean.
    this.stopChecking(workerId, namespace);

    const key = this.key(workerId, namespace);
    const token = Symbol(key);
    const port = portOverride ?? this.getWorkerPort(workerId, config);
    const url = `http://127.0.0.1:${port}${hc.path}`;

    this.checkTokens.set(key, token);
    this.failureCounts.set(key, 0);
    this.checking.set(key, false);

    // Run the first check immediately instead of waiting one full interval.
    void this.performCheck(key, token, workerId, namespace, url, hc.timeout, hc.unhealthyThreshold);

    const timer = setInterval(() => {
      void this.performCheck(
        key,
        token,
        workerId,
        namespace,
        url,
        hc.timeout,
        hc.unhealthyThreshold,
      );
    }, hc.interval);

    this.timers.set(key, timer);
  }

  /** Stop HTTP health checking for `workerId` and reset its counters. */
  stopChecking(workerId: number, namespace: string = ''): void {
    const key = this.key(workerId, namespace);
    const timer = this.timers.get(key);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(key);
    }
    this.controllers.get(key)?.abort();
    this.controllers.delete(key);
    this.checkTokens.delete(key);
    this.failureCounts.delete(key);
    this.checking.delete(key);
  }

  // -----------------------------------------------------------------------
  // IPC Heartbeat
  // -----------------------------------------------------------------------

  /** Record a heartbeat from `workerId`. */
  onHeartbeat(workerId: number, namespace: string = ''): void {
    this.lastHeartbeat.set(this.key(workerId, namespace), Date.now());
  }

  /**
   * Returns `true` when the worker has missed `HEARTBEAT_MISS_THRESHOLD` or
   * more consecutive heartbeat windows (each window = `HEARTBEAT_INTERVAL` ms).
   */
  isHeartbeatStale(workerId: number, namespace: string = ''): boolean {
    const key = this.key(workerId, namespace);
    // Fall back to the monitor-start baseline when no genuine heartbeat has
    // arrived yet, so a worker that never beats is still measured from start.
    const last = this.lastHeartbeat.get(key) ?? this.monitorStartedAt.get(key);
    if (last === undefined) return false;

    const elapsed = Date.now() - last;
    return elapsed >= HEARTBEAT_INTERVAL * HEARTBEAT_MISS_THRESHOLD;
  }

  /**
   * Start a periodic monitor that invokes `onStale` when `workerId`'s
   * heartbeat becomes stale.
   */
  startHeartbeatMonitor(
    workerId: number,
    onStale: (workerId: number) => void,
    namespace: string = '',
  ): void {
    this.stopHeartbeatMonitor(workerId, namespace);
    const key = this.key(workerId, namespace);

    // Record the monitor-start baseline (not a fake heartbeat) so staleness is
    // measured from start until the first genuine heartbeat arrives.
    this.monitorStartedAt.set(key, Date.now());

    const timer = setInterval(() => {
      if (this.isHeartbeatStale(workerId, namespace)) {
        onStale(workerId);
      }
    }, HEARTBEAT_INTERVAL);

    this.heartbeatTimers.set(key, timer);
  }

  /** Stop the heartbeat monitor for `workerId`. */
  stopHeartbeatMonitor(workerId: number, namespace: string = ''): void {
    const key = this.key(workerId, namespace);
    const timer = this.heartbeatTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(key);
    }
    this.lastHeartbeat.delete(key);
    this.monitorStartedAt.delete(key);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Stop all timers for every tracked worker. */
  stopAll(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    for (const controller of this.controllers.values()) controller.abort();
    this.timers.clear();
    this.heartbeatTimers.clear();
    this.controllers.clear();
    this.checkTokens.clear();
    this.failureCounts.clear();
    this.checking.clear();
    this.lastHeartbeat.clear();
    this.monitorStartedAt.clear();
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Execute a single HTTP health check.  Uses `fetch` with an
   * `AbortController` so the request is aborted if it exceeds `timeout` ms.
   */
  private async performCheck(
    key: string,
    token: symbol,
    workerId: number,
    namespace: string,
    url: string,
    timeout: number,
    threshold: number,
  ): Promise<void> {
    // Guard: skip if a previous check is still in-flight for this worker.
    if (this.checkTokens.get(key) !== token || this.checking.get(key)) return;
    this.checking.set(key, true);

    const controller = new AbortController();
    this.controllers.set(key, controller);
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const res = await fetch(url, { signal: controller.signal });

      // M2: we only care about the status — drain the body so the keep-alive
      // connection is released immediately instead of lingering until GC. The
      // no-op catch keeps a cancel rejection from flipping a healthy check.
      await res.body?.cancel().catch(() => {});

      if (res.ok) {
        // Success – reset the failure counter.
        if (this.checkTokens.get(key) === token) this.failureCounts.set(key, 0);
      } else {
        this.recordFailure(key, token, workerId, namespace, threshold, `HTTP ${res.status}`);
      }
    } catch (err) {
      if (this.checkTokens.get(key) !== token) return;
      const message = err instanceof Error ? err.message : 'unknown error';
      this.recordFailure(key, token, workerId, namespace, threshold, message);
    } finally {
      clearTimeout(timeoutId);
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      if (this.checkTokens.get(key) === token) this.checking.set(key, false);
    }
  }

  /** Increment failure count and emit if threshold reached. */
  private recordFailure(
    key: string,
    token: symbol,
    workerId: number,
    namespace: string,
    threshold: number,
    reason: string,
  ): void {
    if (this.checkTokens.get(key) !== token) return;
    const count = (this.failureCounts.get(key) ?? 0) + 1;
    this.failureCounts.set(key, count);

    if (count === threshold) {
      this.emitUnhealthy(workerId, `health check failed ${count} times: ${reason}`, namespace);
    }
  }

  private key(workerId: number, namespace: string): string {
    return `${namespace}\0${workerId}`;
  }
}
