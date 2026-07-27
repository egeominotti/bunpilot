// ---------------------------------------------------------------------------
// bunpilot – Signal Handler Unit Tests
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  removeSignalHandlers,
  type SignalCallbacks,
  setupSignalHandlers,
} from '../../src/core/signals';

describe('setupSignalHandlers', () => {
  // Track listeners added/removed so we can verify handler registration
  // without actually sending signals to the process.
  let originalOn: typeof process.on;
  let originalRemoveListener: typeof process.removeListener;

  let addedListeners: Map<string, ((...args: unknown[]) => void)[]>;
  let removedSignals: string[];

  beforeEach(() => {
    addedListeners = new Map();
    removedSignals = [];

    originalOn = process.on.bind(process);
    originalRemoveListener = process.removeListener.bind(process);

    // Intercept process.on to track registrations
    process.on = ((event: string, handler: (...args: unknown[]) => void) => {
      if (!addedListeners.has(event)) {
        addedListeners.set(event, []);
      }
      addedListeners.get(event)!.push(handler);
      return process;
    }) as typeof process.on;

    // Intercept process.removeListener to track removals
    process.removeListener = ((event: string, _handler: (...args: unknown[]) => void) => {
      removedSignals.push(event);
      return process;
    }) as typeof process.removeListener;
  });

  afterEach(() => {
    // Restore originals
    process.on = originalOn;
    process.removeListener = originalRemoveListener;
    // Clean up any registered handlers
    removeSignalHandlers();
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  test('registers handlers for SIGTERM, SIGINT, SIGHUP, SIGPIPE, and unhandledRejection', () => {
    const callbacks: SignalCallbacks = {
      onShutdown: () => {},
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);

    expect(addedListeners.has('SIGTERM')).toBe(true);
    expect(addedListeners.has('SIGINT')).toBe(true);
    expect(addedListeners.has('SIGHUP')).toBe(true);
    expect(addedListeners.has('SIGPIPE')).toBe(true);
    expect(addedListeners.has('unhandledRejection')).toBe(true);
  });

  test('registers exactly one handler per signal', () => {
    const callbacks: SignalCallbacks = {
      onShutdown: () => {},
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);

    expect(addedListeners.get('SIGTERM')!.length).toBe(1);
    expect(addedListeners.get('SIGINT')!.length).toBe(1);
    expect(addedListeners.get('SIGHUP')!.length).toBe(1);
    expect(addedListeners.get('SIGPIPE')!.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  test('removeSignalHandlers removes all registered handlers', () => {
    const callbacks: SignalCallbacks = {
      onShutdown: () => {},
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);

    // Clear the tracking to isolate the remove calls
    removedSignals = [];

    removeSignalHandlers();

    expect(removedSignals).toContain('SIGTERM');
    expect(removedSignals).toContain('SIGINT');
    expect(removedSignals).toContain('SIGHUP');
    expect(removedSignals).toContain('SIGPIPE');
  });

  test('removeSignalHandlers removes unhandledRejection listener (Bug 10)', () => {
    const callbacks: SignalCallbacks = {
      onShutdown: () => {},
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);

    // Clear the tracking to isolate the remove calls
    removedSignals = [];

    removeSignalHandlers();

    // Should also remove unhandledRejection
    expect(removedSignals).toContain('unhandledRejection');
  });

  test('removeSignalHandlers is a no-op when no handlers are registered', () => {
    // Call remove without setup first — should not throw
    removeSignalHandlers();
    expect(removedSignals).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Calling setupSignalHandlers twice cleans up the first set
  // -------------------------------------------------------------------------

  test('calling setupSignalHandlers twice removes previous handlers first', () => {
    const callbacks: SignalCallbacks = {
      onShutdown: () => {},
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);
    // Second call should trigger removal of the first set
    removedSignals = [];
    setupSignalHandlers(callbacks);

    // The second call should have removed the 4 signal handlers from the first call
    expect(removedSignals).toContain('SIGTERM');
    expect(removedSignals).toContain('SIGINT');
    expect(removedSignals).toContain('SIGHUP');
    expect(removedSignals).toContain('SIGPIPE');
  });

  // -------------------------------------------------------------------------
  // Handler behaviour — invoke handler functions directly
  // -------------------------------------------------------------------------

  test('SIGHUP handler calls onReload', () => {
    let reloadCalled = false;
    const callbacks: SignalCallbacks = {
      onShutdown: () => {},
      onReload: () => {
        reloadCalled = true;
      },
    };

    setupSignalHandlers(callbacks);

    // Invoke the SIGHUP handler directly
    const sighupHandler = addedListeners.get('SIGHUP')![0];
    sighupHandler('SIGHUP');

    expect(reloadCalled).toBe(true);
  });

  test('SIGPIPE handler does nothing (no-op)', () => {
    const callbacks: SignalCallbacks = {
      onShutdown: () => {},
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);

    // Invoking the SIGPIPE handler should not throw
    const sigpipeHandler = addedListeners.get('SIGPIPE')![0];
    expect(() => sigpipeHandler('SIGPIPE')).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Shutdown handler
  // -------------------------------------------------------------------------

  test('shutdown handler calls onShutdown with the signal name', async () => {
    let receivedSignal: string | null = null;

    // We need to prevent process.exit from actually exiting
    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;

    const callbacks: SignalCallbacks = {
      onShutdown: (sig) => {
        receivedSignal = sig;
      },
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);

    const sigtermHandler = addedListeners.get('SIGTERM')![0];
    sigtermHandler('SIGTERM');

    // Wait for the .finally() microtask (process.exit) to fire while still mocked
    await new Promise((r) => setTimeout(r, 10));

    // Explicit type argument: control-flow analysis still has `receivedSignal`
    // narrowed to `null` (it is only ever assigned inside the callback), which
    // is exactly what this assertion exists to disprove.
    expect<string | null>(receivedSignal).toBe('SIGTERM');

    process.exit = originalExit;
  });

  test('shuttingDown guard prevents double shutdown', async () => {
    let shutdownCount = 0;

    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;

    const callbacks: SignalCallbacks = {
      onShutdown: () => {
        shutdownCount++;
      },
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);

    const sigtermHandler = addedListeners.get('SIGTERM')![0];

    // Call shutdown handler twice
    sigtermHandler('SIGTERM');
    sigtermHandler('SIGTERM');

    // Wait for the .finally() microtask to fire while still mocked
    await new Promise((r) => setTimeout(r, 10));

    // Only one should have been processed due to shuttingDown guard
    expect(shutdownCount).toBe(1);

    process.exit = originalExit;
  });

  test('SIGINT handler also triggers shutdown', async () => {
    let receivedSignal: string | null = null;

    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;

    const callbacks: SignalCallbacks = {
      onShutdown: (sig) => {
        receivedSignal = sig;
      },
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);

    const sigintHandler = addedListeners.get('SIGINT')![0];
    sigintHandler('SIGINT');

    // Wait for the .finally() microtask to fire while still mocked
    await new Promise((r) => setTimeout(r, 10));

    // See the SIGTERM case: narrowed to `null` until the callback runs.
    expect<string | null>(receivedSignal).toBe('SIGINT');

    process.exit = originalExit;
  });

  test('shuttingDown guard blocks SIGINT after SIGTERM', async () => {
    let shutdownCount = 0;

    const originalExit = process.exit;
    process.exit = (() => {}) as typeof process.exit;

    const callbacks: SignalCallbacks = {
      onShutdown: () => {
        shutdownCount++;
      },
      onReload: () => {},
    };

    setupSignalHandlers(callbacks);

    const sigtermHandler = addedListeners.get('SIGTERM')![0];
    const sigintHandler = addedListeners.get('SIGINT')![0];

    // First SIGTERM goes through
    sigtermHandler('SIGTERM');
    // Second SIGINT should be blocked by shuttingDown
    sigintHandler('SIGINT');

    // Wait for the .finally() microtask to fire while still mocked
    await new Promise((r) => setTimeout(r, 10));

    expect(shutdownCount).toBe(1);

    process.exit = originalExit;
  });

  // -------------------------------------------------------------------------
  // L10: shutdown still exits (cleanly) when onShutdown rejects
  // -------------------------------------------------------------------------

  test('still exits with code 0 and logs when onShutdown rejects (L10)', async () => {
    const originalExit = process.exit;
    const originalError = console.error;
    let exitCode: number | undefined;
    let loggedError = false;

    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
    }) as typeof process.exit;
    console.error = () => {
      loggedError = true;
    };

    try {
      const callbacks: SignalCallbacks = {
        onShutdown: async () => {
          throw new Error('cleanup blew up');
        },
        onReload: () => {},
      };

      setupSignalHandlers(callbacks);

      const sigtermHandler = addedListeners.get('SIGTERM')![0];
      sigtermHandler('SIGTERM');

      // Wait for the rejected promise's .catch().finally() chain to settle.
      await new Promise((r) => setTimeout(r, 10));

      // The reject branch must log and still exit 0 (finally), not hang.
      expect(loggedError).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      process.exit = originalExit;
      console.error = originalError;
    }
  });

  test('unhandledRejection handler logs without throwing (L10)', () => {
    const originalError = console.error;
    let logged = false;
    console.error = () => {
      logged = true;
    };

    try {
      setupSignalHandlers({ onShutdown: () => {}, onReload: () => {} });
      const handler = addedListeners.get('unhandledRejection')![0];
      expect(() => handler(new Error('boom'))).not.toThrow();
      expect(logged).toBe(true);
    } finally {
      console.error = originalError;
    }
  });
});
