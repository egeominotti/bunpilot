// ---------------------------------------------------------------------------
// bunpilot – Worker SDK: public API for user applications
// ---------------------------------------------------------------------------
//
// Usage:
//   import { bunpilotReady, bunpilotOnShutdown, bunpilotStartMetrics } from 'bunpilot/worker';
//
// ---------------------------------------------------------------------------

import type { WorkerMessage, WorkerMetricsPayload } from '../config/types';
import { HEARTBEAT_INTERVAL } from '../constants';
import { isValidMasterMessage } from '../ipc/protocol';
import {
  collectTelemetry,
  createTelemetryState,
  disposeTelemetryState,
  type TelemetryState,
} from './telemetry';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Safely send an IPC message to the master process. */
function send(message: WorkerMessage): void {
  if (typeof process.send === 'function') {
    process.send(message);
  }
}

// ---------------------------------------------------------------------------
// bunpilotReady
// ---------------------------------------------------------------------------

/**
 * Notify the master that this worker is ready to accept traffic.
 * Must be called after all initialization is complete (server listening, etc.).
 */
export function bunpilotReady(): void {
  send({ type: 'ready' });
  emitHeartbeat();
  bunpilotStartHeartbeat();
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function emitHeartbeat(): void {
  send({ type: 'heartbeat', uptime: process.uptime() });
}

/** Start liveness heartbeats. `bunpilotReady()` calls this automatically. */
export function bunpilotStartHeartbeat(interval: number = HEARTBEAT_INTERVAL): void {
  assertInterval(interval, 'heartbeat interval');
  if (heartbeatTimer !== null) return;

  heartbeatTimer = setInterval(emitHeartbeat, interval);
  heartbeatTimer.unref?.();
}

// ---------------------------------------------------------------------------
// bunpilotOnShutdown
// ---------------------------------------------------------------------------

/**
 * Register a graceful shutdown handler.
 *
 * When the master sends a `shutdown` message (or the process receives SIGTERM /
 * SIGINT) the provided handler is invoked. The handler may return a Promise for
 * async cleanup (e.g. draining connections).
 */
export function bunpilotOnShutdown(handler: () => Promise<void> | void): void {
  if (typeof process.on !== 'function') return;
  shutdownHandlers.add(handler);
  installMessageDispatcher();
  installSignalHandlers();
}

// ---------------------------------------------------------------------------
// bunpilotStartMetrics
// ---------------------------------------------------------------------------

/** Active metrics interval handle – kept for cleanup. */
let metricsTimer: ReturnType<typeof setInterval> | null = null;

/** Lazily-armed deep-telemetry collector state (heap / GC / stack). */
let telemetryState: TelemetryState | null = null;
let telemetryDeep = true;

const shutdownHandlers = new Set<() => Promise<void> | void>();
let messageDispatcherInstalled = false;
let signalHandlersInstalled = false;
let shutdownPromise: Promise<void> | null = null;

function assertInterval(interval: number, label: string): void {
  if (!Number.isSafeInteger(interval) || interval <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function stopTimers(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (metricsTimer !== null) {
    clearInterval(metricsTimer);
    metricsTimer = null;
  }
}

function collectMetrics(): void {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();

  const payload: WorkerMetricsPayload = {
    memory: {
      rss: mem.rss,
      heapTotal: mem.heapTotal,
      heapUsed: mem.heapUsed,
      external: mem.external,
      arrayBuffers: mem.arrayBuffers,
    },
    cpu: { user: cpu.user, system: cpu.system },
  };

  // Deep telemetry (heap / GC / stack). Never let a telemetry failure suppress
  // the basic memory + CPU sample the master relies on for liveness.
  if (telemetryState) {
    try {
      const snapshot = collectTelemetry(telemetryState, telemetryDeep);
      payload.memory.arrayBuffers = snapshot.arrayBuffers;
      payload.heap = snapshot.heap;
      payload.gc = snapshot.gc;
      payload.stack = snapshot.stack;
      payload.eventLoopLag = snapshot.stack.eventLoopLagMs;
      payload.activeHandles = snapshot.stack.activeResources;
    } catch {
      // Degrade to memory + CPU only.
    }
  }

  send({ type: 'metrics', payload });
}

function installMessageDispatcher(): void {
  if (messageDispatcherInstalled || typeof process.on !== 'function') return;
  messageDispatcherInstalled = true;
  process.on('message', (message: unknown) => {
    if (!isValidMasterMessage(message)) return;
    if (message.type === 'shutdown') {
      void runShutdown(message.timeout);
    } else if (message.type === 'collect-metrics' && metricsTimer !== null) {
      collectMetrics();
    } else if (message.type === 'ping') {
      send({ type: 'heartbeat', uptime: process.uptime() });
    }
  });
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled || typeof process.on !== 'function') return;
  signalHandlersInstalled = true;
  process.on('SIGTERM', () => void runShutdown(readShutdownDeadline()));
  process.on('SIGINT', () => void runShutdown(readShutdownDeadline()));
}

/**
 * The graceful-shutdown deadline for the signal path. The master signals the
 * worker and then escalates to SIGKILL after `killTimeout` ms, so the SDK must
 * allow draining up to that same bound — not a hard-coded 5s (h56). The master
 * injects `BUNPILOT_KILL_TIMEOUT`; standalone workers fall back to 5s.
 */
function readShutdownDeadline(): number {
  const raw = Number(process.env.BUNPILOT_KILL_TIMEOUT);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(raw, 300_000);
  }
  return 5_000;
}

function runShutdown(timeout: number): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  const promise = (async () => {
    stopTimers();
    disposeTelemetry();

    // Invoke each handler through Promise.resolve().then so a *synchronous*
    // throw from any handler becomes a rejected promise that allSettled
    // absorbs — instead of aborting the whole shutdown, skipping later
    // handlers, and never reaching process.exit (h12 / h44).
    const cleanup = Promise.allSettled(
      [...shutdownHandlers].map((handler) => Promise.resolve().then(handler)),
    );

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, timeout);
      timeoutHandle.unref?.();
    });
    await Promise.race([cleanup.then(() => undefined), deadline]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    process.exit(0);
    // `process.exit` never returns in production. Test doubles may return,
    // which lets subsequent tests exercise a fresh shutdown request.
    shutdownPromise = null;
  })();
  // The latch must never be left in a rejected state: a rejected shutdownPromise
  // would make every later runShutdown() return it and silently no-op. The IIFE
  // above cannot reject (allSettled never throws), but guard defensively.
  shutdownPromise = promise.catch(() => {
    shutdownPromise = null;
  });
  return shutdownPromise;
}

function disposeTelemetry(): void {
  const state = telemetryState;
  telemetryState = null;
  if (state) {
    try {
      disposeTelemetryState(state);
    } catch {
      // Already disposed.
    }
  }
}

/**
 * Start periodic reporting of process metrics to the master.
 *
 * Reports basic memory + CPU plus runtime telemetry. With `deep: false`, heap
 * walks and runtime-specific census fields are omitted while cheap process
 * heap sizes, derived pressure, and event-loop health remain available.
 *
 * @param interval - Reporting interval in milliseconds (default 5000).
 * @param options  - `{ deep }` toggles runtime heap walks and object census.
 */
export function bunpilotStartMetrics(interval = 5_000, options: { deep?: boolean } = {}): void {
  assertInterval(interval, 'metrics interval');
  telemetryDeep = options.deep ?? true;

  // Avoid duplicate intervals.
  if (metricsTimer !== null) return;

  if (telemetryState === null) {
    try {
      telemetryState = createTelemetryState();
    } catch {
      telemetryState = null;
    }
  }

  metricsTimer = setInterval(collectMetrics, interval);

  // Unref so the timer does not prevent the process from exiting.
  if (metricsTimer && typeof metricsTimer.unref === 'function') {
    metricsTimer.unref();
  }

  installMessageDispatcher();
}
