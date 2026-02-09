// ---------------------------------------------------------------------------
// bunpilot – Signal Handler
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Callback interface
// ---------------------------------------------------------------------------

export interface SignalCallbacks {
  onShutdown(signal: string): Promise<void> | void;
  onReload(): void;
}

// ---------------------------------------------------------------------------
// Handler references (kept for cleanup)
// ---------------------------------------------------------------------------

type SignalHandler = (signal: NodeJS.Signals) => void;

const registeredHandlers = new Map<NodeJS.Signals, SignalHandler>();

/** Bug 10 fix: Store the unhandledRejection listener for cleanup. */
let unhandledRejectionHandler: ((reason: unknown) => void) | null = null;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Wire up process signal handlers:
 *
 *   SIGTERM / SIGINT  -> onShutdown
 *   SIGHUP            -> onReload
 *   SIGPIPE           -> ignore
 */
export function setupSignalHandlers(callbacks: SignalCallbacks): void {
  // Clean up any previously registered handlers to avoid stacking.
  removeSignalHandlers();

  let shuttingDown = false;
  const shutdownHandler: SignalHandler = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    Promise.resolve(callbacks.onShutdown(sig))
      .catch((err) => {
        console.error('[signals] shutdown error:', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  const reloadHandler: SignalHandler = () => callbacks.onReload();
  const ignoreHandler: SignalHandler = () => {
    /* intentionally empty – ignore SIGPIPE */
  };

  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);
  process.on('SIGHUP', reloadHandler);
  process.on('SIGPIPE', ignoreHandler);

  unhandledRejectionHandler = (reason: unknown) => {
    console.error('[bunpilot] unhandled rejection:', reason);
  };
  process.on('unhandledRejection', unhandledRejectionHandler);

  registeredHandlers.set('SIGTERM', shutdownHandler);
  registeredHandlers.set('SIGINT', shutdownHandler);
  registeredHandlers.set('SIGHUP', reloadHandler);
  registeredHandlers.set('SIGPIPE', ignoreHandler);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Remove all signal handlers that were registered via `setupSignalHandlers`. */
export function removeSignalHandlers(): void {
  for (const [signal, handler] of registeredHandlers) {
    process.removeListener(signal, handler);
  }
  registeredHandlers.clear();

  // Bug 10 fix: Remove the unhandledRejection listener.
  if (unhandledRejectionHandler) {
    process.removeListener('unhandledRejection', unhandledRejectionHandler);
    unhandledRejectionHandler = null;
  }
}
