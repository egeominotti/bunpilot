// ---------------------------------------------------------------------------
// bunpm2 – SO_REUSEPORT Cluster Implementation
// ---------------------------------------------------------------------------
//
// On Linux the kernel distributes incoming connections across all sockets
// bound to the same port with SO_REUSEPORT.  This means we don't need a
// userland proxy – every worker simply listens on the *same* public port
// and the kernel takes care of load balancing.
//
// The class below is intentionally minimal: most methods are no-ops because
// there is no proxy state to manage.
// ---------------------------------------------------------------------------

/**
 * Cluster implementation for the `reusePort` strategy.
 *
 * Since the kernel handles load balancing there is almost nothing for us to
 * do.  The main responsibility is providing the correct environment variables
 * so each worker knows it should bind with `reusePort: true`.
 */
export class ReusePortCluster {
  // -----------------------------------------------------------------------
  // Worker environment
  // -----------------------------------------------------------------------

  /**
   * Returns the env vars that the master should inject into a worker process.
   *
   * - `BUNPM2_PORT`       – the public port the worker should bind to.
   * - `BUNPM2_REUSE_PORT` – `'1'` signals the worker to set `reusePort: true`.
   */
  getWorkerEnv(workerId: number, port: number): Record<string, string> {
    return {
      BUNPM2_PORT: String(port),
      BUNPM2_REUSE_PORT: '1',
    };
  }

  // -----------------------------------------------------------------------
  // Lifecycle (all no-ops – the kernel handles everything)
  // -----------------------------------------------------------------------

  /** No-op – the kernel distributes connections automatically. */
  addWorker(_workerId: number): void {
    // Nothing to do; the kernel picks up new listeners on its own.
  }

  /** No-op – when a worker closes its socket the kernel stops sending it traffic. */
  removeWorker(_workerId: number): void {
    // Nothing to do.
  }

  /** No-op – there is no proxy to tear down. */
  stop(): void {
    // Nothing to do.
  }
}
