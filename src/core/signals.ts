// ---------------------------------------------------------------------------
// bunpm – Signal Handler
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Callback interface
// ---------------------------------------------------------------------------

export interface SignalCallbacks {
  onShutdown(signal: string): void;
  onReload(): void;
}

// ---------------------------------------------------------------------------
// Handler references (kept for cleanup)
// ---------------------------------------------------------------------------

type SignalHandler = (signal: NodeJS.Signals) => void;

const registeredHandlers = new Map<NodeJS.Signals, SignalHandler>();

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

  const shutdownHandler: SignalHandler = (sig) => callbacks.onShutdown(sig);
  const reloadHandler: SignalHandler = () => callbacks.onReload();
  const ignoreHandler: SignalHandler = () => {
    /* intentionally empty – ignore SIGPIPE */
  };

  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);
  process.on('SIGHUP', reloadHandler);
  process.on('SIGPIPE', ignoreHandler);

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
}
