// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Worker SDK
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

// ---------------------------------------------------------------------------
// We need to reset module state between tests since bunpilotStartMetrics
// uses a module-level `metricsTimer`. We dynamically import the module
// to get fresh state where needed.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let originalSend: typeof process.send;
let sentMessages: unknown[];

beforeEach(() => {
  sentMessages = [];
  originalSend = process.send as typeof process.send;
  // Install a mock process.send
  (process as { send?: Function }).send = (msg: unknown) => {
    sentMessages.push(msg);
  };
});

afterEach(() => {
  // Restore original process.send
  if (originalSend) {
    (process as { send?: Function }).send = originalSend;
  } else {
    delete (process as { send?: Function }).send;
  }
});

// ---------------------------------------------------------------------------
// bunpilotReady
// ---------------------------------------------------------------------------

describe('bunpilotReady', () => {
  test('sends a ready message via process.send', async () => {
    const { bunpilotReady } = await import('../../src/sdk/worker');
    bunpilotReady();

    expect(sentMessages.length).toBeGreaterThanOrEqual(1);
    const readyMsg = sentMessages.find(
      (m) => typeof m === 'object' && m !== null && (m as { type: string }).type === 'ready'
    );
    expect(readyMsg).toEqual({ type: 'ready' });
  });

  test('does not throw when process.send is not defined', async () => {
    // Temporarily remove process.send
    delete (process as { send?: Function }).send;

    const { bunpilotReady } = await import('../../src/sdk/worker');
    expect(() => bunpilotReady()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// bunpilotOnShutdown
// ---------------------------------------------------------------------------

describe('bunpilotOnShutdown', () => {
  test('registers a message handler on process', async () => {
    const { bunpilotOnShutdown } = await import('../../src/sdk/worker');

    let shutdownCalled = false;
    const handler = () => {
      shutdownCalled = true;
    };

    // Count listeners before
    const listenersBefore = process.listenerCount('message');

    bunpilotOnShutdown(handler);

    // A new message listener should be registered
    const listenersAfter = process.listenerCount('message');
    expect(listenersAfter).toBeGreaterThan(listenersBefore);
  });

  test('handler is invoked when shutdown message is received', async () => {
    const { bunpilotOnShutdown } = await import('../../src/sdk/worker');

    let shutdownCalled = false;

    // Mock process.exit to prevent test from exiting
    const originalExit = process.exit;
    (process as { exit: Function }).exit = () => {
      // no-op in tests
    };

    bunpilotOnShutdown(() => {
      shutdownCalled = true;
    });

    // Emit a shutdown message
    process.emit('message', { type: 'shutdown', timeout: 5000 });

    // Give async handler time to run
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(shutdownCalled).toBe(true);

    // Restore process.exit
    (process as { exit: Function }).exit = originalExit;
  });

  test('handler ignores non-shutdown messages', async () => {
    const { bunpilotOnShutdown } = await import('../../src/sdk/worker');

    let shutdownCalled = false;

    bunpilotOnShutdown(() => {
      shutdownCalled = true;
    });

    // Emit a non-shutdown message
    process.emit('message', { type: 'ping' });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(shutdownCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// bunpilotStartMetrics
// ---------------------------------------------------------------------------

describe('bunpilotStartMetrics', () => {
  test('starts sending metrics at the given interval', async () => {
    const { bunpilotStartMetrics } = await import('../../src/sdk/worker');

    bunpilotStartMetrics(100);

    // Wait for at least one metrics interval
    await new Promise((resolve) => setTimeout(resolve, 250));

    const metricsMessages = sentMessages.filter(
      (m) => typeof m === 'object' && m !== null && (m as { type: string }).type === 'metrics'
    );

    expect(metricsMessages.length).toBeGreaterThanOrEqual(1);

    // Verify the shape of the metrics payload
    const msg = metricsMessages[0] as {
      type: string;
      payload: { memory: object; cpu: object };
    };
    expect(msg.type).toBe('metrics');
    expect(msg.payload).toBeDefined();
    expect(msg.payload.memory).toBeDefined();
    expect(msg.payload.cpu).toBeDefined();
  });

  test('does not create duplicate intervals on multiple calls', async () => {
    const { bunpilotStartMetrics } = await import('../../src/sdk/worker');

    // Note: since metricsTimer is module-level, this test relies on the
    // guard `if (metricsTimer !== null) return;` in the source.
    // The first call from previous tests already set the timer.
    // Calling again should not create a second interval.
    const messagesBefore = sentMessages.length;

    bunpilotStartMetrics(100);
    bunpilotStartMetrics(100);

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 250));

    // The count should be consistent with a single interval
    // (not doubled from two intervals running simultaneously)
    const metricsMessages = sentMessages
      .slice(messagesBefore)
      .filter(
        (m) => typeof m === 'object' && m !== null && (m as { type: string }).type === 'metrics'
      );

    // With a 100ms interval over 250ms, we expect ~2-3 messages, not 4-6
    expect(metricsMessages.length).toBeLessThanOrEqual(4);
  });

  test('responds to collect-metrics message', async () => {
    const { bunpilotStartMetrics } = await import('../../src/sdk/worker');

    bunpilotStartMetrics(60_000); // Long interval so periodic doesn't fire

    // Clear any messages accumulated so far
    sentMessages.length = 0;

    // Emit a collect-metrics message
    process.emit('message', { type: 'collect-metrics' });

    // Give it time to respond
    await new Promise((resolve) => setTimeout(resolve, 50));

    const metricsMessages = sentMessages.filter(
      (m) => typeof m === 'object' && m !== null && (m as { type: string }).type === 'metrics'
    );

    expect(metricsMessages.length).toBeGreaterThanOrEqual(1);
  });
});
