// ---------------------------------------------------------------------------
// bunpm – IPC Protocol: validation and message factories
// ---------------------------------------------------------------------------

import type { WorkerMessage, MasterMessage } from '../config/types';

// ---------------------------------------------------------------------------
// Worker -> Master validation
// ---------------------------------------------------------------------------

const WORKER_MESSAGE_TYPES = new Set(['ready', 'metrics', 'heartbeat', 'custom']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidMetricsPayload(payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  const { memory, cpu } = payload;
  if (!isPlainObject(memory)) return false;
  if (!isPlainObject(cpu)) return false;

  const memKeys = ['rss', 'heapTotal', 'heapUsed', 'external'] as const;
  for (const key of memKeys) {
    if (typeof memory[key] !== 'number') return false;
  }

  const cpuKeys = ['user', 'system'] as const;
  for (const key of cpuKeys) {
    if (typeof cpu[key] !== 'number') return false;
  }

  return true;
}

/**
 * Type-guard that validates a worker -> master IPC message.
 * Returns true only when the shape matches one of the `WorkerMessage` variants.
 */
export function isValidWorkerMessage(msg: unknown): msg is WorkerMessage {
  if (!isPlainObject(msg)) return false;

  const { type } = msg;
  if (typeof type !== 'string' || !WORKER_MESSAGE_TYPES.has(type)) return false;

  switch (type) {
    case 'ready':
      return true;

    case 'metrics':
      return isValidMetricsPayload(msg.payload);

    case 'heartbeat':
      return typeof msg.uptime === 'number';

    case 'custom':
      return typeof msg.channel === 'string';

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Master -> Worker validation
// ---------------------------------------------------------------------------

const MASTER_MESSAGE_TYPES = new Set(['shutdown', 'ping', 'collect-metrics', 'config-update']);

/**
 * Type-guard that validates a master -> worker IPC message.
 * Returns true only when the shape matches one of the `MasterMessage` variants.
 */
export function isValidMasterMessage(msg: unknown): msg is MasterMessage {
  if (!isPlainObject(msg)) return false;

  const { type } = msg;
  if (typeof type !== 'string' || !MASTER_MESSAGE_TYPES.has(type)) return false;

  switch (type) {
    case 'shutdown':
      return typeof msg.timeout === 'number' && msg.timeout >= 0;

    case 'ping':
    case 'collect-metrics':
      return true;

    case 'config-update':
      return isPlainObject(msg.config);

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Message factories
// ---------------------------------------------------------------------------

export function createShutdownMessage(timeout: number): MasterMessage {
  return { type: 'shutdown', timeout };
}

export function createPingMessage(): MasterMessage {
  return { type: 'ping' };
}

export function createCollectMetricsMessage(): MasterMessage {
  return { type: 'collect-metrics' };
}
