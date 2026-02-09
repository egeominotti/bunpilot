// ---------------------------------------------------------------------------
// bunpilot – Worker SDK: public API for user applications
// ---------------------------------------------------------------------------
//
// Usage:
//   import { bunpilotReady, bunpilotOnShutdown, bunpilotStartMetrics } from 'bunpilot/worker';
//
// ---------------------------------------------------------------------------

import type { WorkerMessage, MasterMessage } from '../config/types';

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

  process.on('message', async (msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && (msg as MasterMessage).type === 'shutdown') {
      try {
        await handler();
      } finally {
        process.exit(0);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// bunpilotStartMetrics
// ---------------------------------------------------------------------------

/** Active metrics interval handle – kept for cleanup. */
let metricsTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start periodic reporting of process metrics (memory + CPU) to the master.
 *
 * @param interval - Reporting interval in milliseconds (default 5000).
 */
export function bunpilotStartMetrics(interval: number = 5_000): void {
  // Avoid duplicate intervals
  if (metricsTimer !== null) return;

  metricsTimer = setInterval(() => {
    const mem = process.memoryUsage();
    const cpuNow = process.cpuUsage();

    send({
      type: 'metrics',
      payload: {
        memory: {
          rss: mem.rss,
          heapTotal: mem.heapTotal,
          heapUsed: mem.heapUsed,
          external: mem.external,
        },
        cpu: {
          user: cpuNow.user,
          system: cpuNow.system,
        },
      },
    });
  }, interval);

  // Unref so the timer does not prevent the process from exiting
  if (metricsTimer && typeof metricsTimer.unref === 'function') {
    metricsTimer.unref();
  }

  // Also respond to on-demand collect-metrics requests
  if (typeof process.on === 'function') {
    process.on('message', (msg: unknown) => {
      if (
        typeof msg === 'object' &&
        msg !== null &&
        (msg as MasterMessage).type === 'collect-metrics'
      ) {
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
            cpu: {
              user: cpu.user,
              system: cpu.system,
            },
          },
        });
      }
    });
  }
}
