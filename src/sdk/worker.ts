// ---------------------------------------------------------------------------
// bunpilot – Worker SDK: public API for user applications
// ---------------------------------------------------------------------------
//
// Usage:
//   import { bunpilotReady, bunpilotOnShutdown, bunpilotStartMetrics } from 'bunpilot/worker';
//
// ---------------------------------------------------------------------------

import type { WorkerMessage } from '../config/types';
import { HEARTBEAT_INTERVAL } from '../constants';
import { isValidMasterMessage } from '../ipc/protocol';

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
 * When the master sends a `shutdown` message, the provided handler is invoked.
 * The handler may return a Promise for async cleanup (e.g. draining connections).
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
  send({
    type: 'metrics',
    payload: {
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
      },
      cpu: { user: cpu.user, system: cpu.system },
    },
  });
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
  process.on('SIGTERM', () => void runShutdown(5_000));
  process.on('SIGINT', () => void runShutdown(5_000));
}

function runShutdown(timeout: number): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    stopTimers();
    const cleanup = Promise.allSettled([...shutdownHandlers].map((handler) => handler()));
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, timeout);
    });
    await Promise.race([cleanup.then(() => undefined), deadline]);
    if (timeoutHandle) clearTimeout(timeoutHandle);
    process.exit(0);
    // `process.exit` never returns in production. Test doubles may return,
    // which lets subsequent tests exercise a fresh shutdown request.
    shutdownPromise = null;
  })();
  return shutdownPromise;
}

/**
 * Start periodic reporting of process metrics (memory + CPU) to the master.
 *
 * @param interval - Reporting interval in milliseconds (default 5000).
 */
export function bunpilotStartMetrics(interval: number = 5_000): void {
  assertInterval(interval, 'metrics interval');
  // Avoid duplicate intervals
  if (metricsTimer !== null) return;

  metricsTimer = setInterval(collectMetrics, interval);

  // Unref so the timer does not prevent the process from exiting
  if (metricsTimer && typeof metricsTimer.unref === 'function') {
    metricsTimer.unref();
  }

  installMessageDispatcher();
}
