// ---------------------------------------------------------------------------
// bunpm – IPC Router: dispatches validated worker messages to callbacks
// ---------------------------------------------------------------------------

import type { WorkerMessage, WorkerMetricsPayload } from '../config/types';
import { isValidWorkerMessage } from './protocol';

// ---------------------------------------------------------------------------
// Callback signatures
// ---------------------------------------------------------------------------

export interface IpcRouterCallbacks {
  onReady: (workerId: number) => void;
  onMetrics: (workerId: number, payload: WorkerMetricsPayload) => void;
  onHeartbeat: (workerId: number, uptime: number) => void;
  onCustom: (workerId: number, channel: string, data: unknown) => void;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Validates incoming worker IPC messages and dispatches them to the
 * appropriate callback.  Never throws – unknown or malformed messages
 * are logged and silently ignored.
 */
export class IpcRouter {
  private readonly callbacks: IpcRouterCallbacks;

  constructor(callbacks: IpcRouterCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Handle a raw message coming from a worker process.
   * The `msg` value is `unknown` because it comes straight off the IPC channel.
   */
  handleMessage(workerId: number, msg: unknown): void {
    if (!isValidWorkerMessage(msg)) {
      console.warn(`[ipc-router] worker ${workerId}: unknown or malformed message`, msg);
      return;
    }

    this.dispatch(workerId, msg);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private dispatch(workerId: number, msg: WorkerMessage): void {
    switch (msg.type) {
      case 'ready':
        this.callbacks.onReady(workerId);
        break;

      case 'metrics':
        this.callbacks.onMetrics(workerId, msg.payload);
        break;

      case 'heartbeat':
        this.callbacks.onHeartbeat(workerId, msg.uptime);
        break;

      case 'custom':
        this.callbacks.onCustom(workerId, msg.channel, msg.data);
        break;
    }
  }
}
