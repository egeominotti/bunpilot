// ---------------------------------------------------------------------------
// bunpilot – IPC Protocol unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  isValidWorkerMessage,
  isValidMasterMessage,
  createShutdownMessage,
  createPingMessage,
  createCollectMetricsMessage,
} from '../../src/ipc/protocol';

describe('isValidWorkerMessage', () => {
  test('accepts a valid "ready" message', () => {
    expect(isValidWorkerMessage({ type: 'ready' })).toBe(true);
  });

  test('accepts a valid "heartbeat" message with uptime', () => {
    expect(isValidWorkerMessage({ type: 'heartbeat', uptime: 12345 })).toBe(true);
  });

  test('rejects "heartbeat" without uptime', () => {
    expect(isValidWorkerMessage({ type: 'heartbeat' })).toBe(false);
  });

  test('accepts a valid "metrics" message with full payload', () => {
    const msg = {
      type: 'metrics',
      payload: {
        memory: {
          rss: 50_000_000,
          heapTotal: 30_000_000,
          heapUsed: 20_000_000,
          external: 1_000_000,
        },
        cpu: {
          user: 100_000,
          system: 50_000,
        },
      },
    };
    expect(isValidWorkerMessage(msg)).toBe(true);
  });

  test('rejects "metrics" with incomplete memory payload', () => {
    const msg = {
      type: 'metrics',
      payload: {
        memory: { rss: 100 }, // missing heapTotal, heapUsed, external
        cpu: { user: 0, system: 0 },
      },
    };
    expect(isValidWorkerMessage(msg)).toBe(false);
  });

  test('rejects "metrics" with missing cpu payload', () => {
    const msg = {
      type: 'metrics',
      payload: {
        memory: { rss: 1, heapTotal: 2, heapUsed: 3, external: 4 },
      },
    };
    expect(isValidWorkerMessage(msg)).toBe(false);
  });

  test('accepts a valid "custom" message with channel', () => {
    expect(isValidWorkerMessage({ type: 'custom', channel: 'my-channel', data: {} })).toBe(true);
  });

  test('rejects "custom" without channel', () => {
    expect(isValidWorkerMessage({ type: 'custom' })).toBe(false);
  });

  test('rejects an invalid type', () => {
    expect(isValidWorkerMessage({ type: 'unknown' })).toBe(false);
  });

  test('rejects a non-object value (string)', () => {
    expect(isValidWorkerMessage('not-an-object')).toBe(false);
  });

  test('rejects null', () => {
    expect(isValidWorkerMessage(null)).toBe(false);
  });

  test('rejects an array', () => {
    expect(isValidWorkerMessage([{ type: 'ready' }])).toBe(false);
  });

  test('rejects a message without a type field', () => {
    expect(isValidWorkerMessage({ foo: 'bar' })).toBe(false);
  });
});

describe('isValidMasterMessage', () => {
  test('accepts a valid "shutdown" message', () => {
    expect(isValidMasterMessage({ type: 'shutdown', timeout: 5000 })).toBe(true);
  });

  test('rejects "shutdown" without timeout', () => {
    expect(isValidMasterMessage({ type: 'shutdown' })).toBe(false);
  });

  test('rejects "shutdown" with negative timeout', () => {
    expect(isValidMasterMessage({ type: 'shutdown', timeout: -1 })).toBe(false);
  });

  test('accepts a valid "ping" message', () => {
    expect(isValidMasterMessage({ type: 'ping' })).toBe(true);
  });

  test('accepts a valid "collect-metrics" message', () => {
    expect(isValidMasterMessage({ type: 'collect-metrics' })).toBe(true);
  });

  test('accepts a valid "config-update" message', () => {
    expect(isValidMasterMessage({ type: 'config-update', config: { port: 3000 } })).toBe(true);
  });

  test('rejects "config-update" without config object', () => {
    expect(isValidMasterMessage({ type: 'config-update' })).toBe(false);
  });

  test('rejects an invalid type', () => {
    expect(isValidMasterMessage({ type: 'invalid-cmd' })).toBe(false);
  });

  test('rejects a non-object value', () => {
    expect(isValidMasterMessage(42)).toBe(false);
  });

  test('rejects null', () => {
    expect(isValidMasterMessage(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Message factory functions
// ---------------------------------------------------------------------------

describe('createShutdownMessage', () => {
  test('returns a message with type "shutdown" and the given timeout', () => {
    const msg = createShutdownMessage(5000);
    expect(msg).toEqual({ type: 'shutdown', timeout: 5000 });
  });

  test('accepts zero as a valid timeout', () => {
    const msg = createShutdownMessage(0);
    expect(msg).toEqual({ type: 'shutdown', timeout: 0 });
  });

  test('preserves large timeout values', () => {
    const msg = createShutdownMessage(60_000);
    expect(msg.type).toBe('shutdown');
    expect((msg as { timeout: number }).timeout).toBe(60_000);
  });

  test('produces a valid master message', () => {
    const msg = createShutdownMessage(3000);
    expect(isValidMasterMessage(msg)).toBe(true);
  });
});

describe('createPingMessage', () => {
  test('returns a message with type "ping"', () => {
    const msg = createPingMessage();
    expect(msg).toEqual({ type: 'ping' });
  });

  test('has no extra properties beyond type', () => {
    const msg = createPingMessage();
    expect(Object.keys(msg)).toEqual(['type']);
  });

  test('produces a valid master message', () => {
    const msg = createPingMessage();
    expect(isValidMasterMessage(msg)).toBe(true);
  });
});

describe('createCollectMetricsMessage', () => {
  test('returns a message with type "collect-metrics"', () => {
    const msg = createCollectMetricsMessage();
    expect(msg).toEqual({ type: 'collect-metrics' });
  });

  test('has no extra properties beyond type', () => {
    const msg = createCollectMetricsMessage();
    expect(Object.keys(msg)).toEqual(['type']);
  });

  test('produces a valid master message', () => {
    const msg = createCollectMetricsMessage();
    expect(isValidMasterMessage(msg)).toBe(true);
  });
});
