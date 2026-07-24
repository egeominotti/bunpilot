// ---------------------------------------------------------------------------
// bunpilot – IPC Protocol: validation and message factories
// ---------------------------------------------------------------------------

import type { MasterMessage, WorkerMessage } from '../config/types';

// ---------------------------------------------------------------------------
// Worker -> Master validation
// ---------------------------------------------------------------------------

const WORKER_MESSAGE_TYPES = new Set(['ready', 'metrics', 'heartbeat', 'custom']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

/** Every listed key must be a finite, non-negative number. */
function allNonNegative(obj: Record<string, unknown>, keys: readonly string[]): boolean {
  for (const key of keys) {
    if (!isNonNegativeFiniteNumber(obj[key])) return false;
  }
  return true;
}

const HEAP_KEYS = [
  'heapSize',
  'heapCapacity',
  'extraMemory',
  'objectCount',
  'protectedObjectCount',
  'globalObjectCount',
  'usedHeapSize',
  'totalHeapSize',
  'heapSizeLimit',
  'mallocedMemory',
  'peakMallocedMemory',
  'nativeContexts',
  'detachedContexts',
  'arrayBuffers',
] as const;

const GC_NONNEG_KEYS = [
  'allocationRateBytesPerSec',
  'reclaimedBytes',
  'inferredCollections',
  'heapUtilization',
  'compileTimeMs',
] as const;

const STACK_KEYS = [
  'eventLoopLagMs',
  'eventLoopLagMaxMs',
  'eventLoopLagP99Ms',
  'eventLoopUtilization',
  'activeResources',
  'callStackDepth',
] as const;

/** Bound on how many object-type buckets a heap sample may carry. */
const MAX_HEAP_OBJECT_TYPES = 64;

function isValidHeap(heap: unknown): boolean {
  if (!isPlainObject(heap)) return false;
  if (!allNonNegative(heap, HEAP_KEYS)) return false;
  const { topObjectTypes } = heap;
  if (!Array.isArray(topObjectTypes) || topObjectTypes.length > MAX_HEAP_OBJECT_TYPES) return false;
  for (const entry of topObjectTypes) {
    if (!isPlainObject(entry)) return false;
    if (typeof entry.type !== 'string' || entry.type.length > 128) return false;
    if (!isNonNegativeFiniteNumber(entry.count)) return false;
  }
  return true;
}

function isValidGc(gc: unknown): boolean {
  if (!isPlainObject(gc)) return false;
  // heapGrowthBytes may be negative (net reclaim); the rest are non-negative.
  if (!isFiniteNumber(gc.heapGrowthBytes)) return false;
  return allNonNegative(gc, GC_NONNEG_KEYS);
}

function isValidStack(stack: unknown): boolean {
  if (!isPlainObject(stack)) return false;
  return allNonNegative(stack, STACK_KEYS);
}

function isValidMetricsPayload(payload: unknown): boolean {
  if (!isPlainObject(payload)) return false;
  const { memory, cpu } = payload;
  if (!isPlainObject(memory)) return false;
  if (!isPlainObject(cpu)) return false;

  const memKeys = ['rss', 'heapTotal', 'heapUsed', 'external'] as const;
  if (!allNonNegative(memory, memKeys)) return false;
  if (memory.arrayBuffers !== undefined && !isNonNegativeFiniteNumber(memory.arrayBuffers)) {
    return false;
  }

  const cpuKeys = ['user', 'system'] as const;
  if (!allNonNegative(cpu, cpuKeys)) return false;

  // Optional deep telemetry — if present it must be well-formed (fail closed).
  if (payload.heap !== undefined && !isValidHeap(payload.heap)) return false;
  if (payload.gc !== undefined && !isValidGc(payload.gc)) return false;
  if (payload.stack !== undefined && !isValidStack(payload.stack)) return false;

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
      return isNonNegativeFiniteNumber(msg.uptime);

    case 'custom':
      return typeof msg.channel === 'string' && msg.channel.length > 0 && msg.channel.length <= 256;

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
      return isNonNegativeFiniteNumber(msg.timeout);

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
