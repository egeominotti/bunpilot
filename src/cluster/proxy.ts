// ---------------------------------------------------------------------------
// bunpm2 – TCP Proxy Cluster (macOS / non-reusePort platforms)
// ---------------------------------------------------------------------------
//
// On platforms where SO_REUSEPORT doesn't distribute connections (e.g. macOS)
// we run a lightweight TCP proxy in the master process.  The proxy listens on
// the *public* port and round-robins each accepted connection to one of the
// internal worker ports.
//
// Worker N listens on `INTERNAL_PORT_BASE + workerId` (e.g. 40001, 40002 …).
// ---------------------------------------------------------------------------

import { INTERNAL_PORT_BASE } from '../constants';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface WorkerSlot {
  port: number;
  alive: boolean;
}

/**
 * Per-connection state attached to each public-facing socket.
 *
 * `upstream` is typed as `unknown` because Bun's internal Socket type uses
 * `Bun.BufferSource` which is structurally incompatible with the standard DOM
 * `BufferSource`.  We cast to a minimal interface at call sites instead.
 */
interface ConnState {
  upstream: unknown;
  pending: Buffer[];
}

/** Minimal interface for calling write/end on Bun sockets via cast. */
interface WritableEnd {
  write(data: Buffer): number;
  end(): void;
}

// ---------------------------------------------------------------------------
// ProxyCluster
// ---------------------------------------------------------------------------

/**
 * A userland TCP proxy that load-balances connections across worker processes
 * using simple round-robin.
 */
export class ProxyCluster {
  /** Indexed by `workerId`. */
  private workers: WorkerSlot[] = [];

  /** Round-robin cursor – always points at the *next* index to try. */
  private rrIndex = 0;

  /** The public-facing TCP listener. */
  private listener: { stop(closeActiveConnections?: boolean): void } | null = null;

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start the TCP proxy on `publicPort`, distributing to `workerCount`
   * internal ports starting at `INTERNAL_PORT_BASE`.
   */
  start(publicPort: number, workerCount: number): void {
    this.workers = Array.from({ length: workerCount }, (_, i) => ({
      port: INTERNAL_PORT_BASE + i,
      alive: false,
    }));

    this.rrIndex = 0;

    this.listener = Bun.listen<ConnState>({
      hostname: '0.0.0.0',
      port: publicPort,
      socket: {
        open: (socket) => {
          socket.data = { upstream: null, pending: [] };
          this.handleConnection(socket as unknown as WritableEnd & { data: ConnState });
        },
        data: (socket, data) => {
          const state = socket.data;
          if (state.upstream) {
            (state.upstream as WritableEnd).write(Buffer.from(data));
          } else {
            state.pending.push(Buffer.from(data));
          }
        },
        close: (socket) => {
          if (socket.data?.upstream) {
            (socket.data.upstream as WritableEnd).end();
          }
        },
        error: (socket) => {
          if (socket.data?.upstream) {
            (socket.data.upstream as WritableEnd).end();
          }
        },
      },
    });
  }

  /**
   * Returns the env vars for a given worker.
   *
   * Each worker binds to its own internal port so the proxy can reach it.
   */
  getWorkerEnv(workerId: number, _port: number): Record<string, string> {
    return {
      BUNPM2_PORT: String(INTERNAL_PORT_BASE + workerId),
      BUNPM2_REUSE_PORT: '0',
    };
  }

  /** Mark worker as alive so the proxy starts sending it traffic. */
  addWorker(workerId: number): void {
    if (this.workers[workerId]) {
      this.workers[workerId].alive = true;
    }
  }

  /** Mark worker as dead so the proxy stops sending it traffic. */
  removeWorker(workerId: number): void {
    if (this.workers[workerId]) {
      this.workers[workerId].alive = false;
    }
  }

  /** Stop the public listener and release all resources. */
  stop(): void {
    if (this.listener) {
      this.listener.stop();
      this.listener = null;
    }
    this.workers = [];
    this.rrIndex = 0;
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Pick the next alive worker using round-robin.
   * Returns `null` when no workers are alive.
   */
  private nextAliveWorker(): WorkerSlot | null {
    const total = this.workers.length;
    if (total === 0) return null;

    for (let i = 0; i < total; i++) {
      const idx = (this.rrIndex + i) % total;
      const worker = this.workers[idx];
      if (worker.alive) {
        this.rrIndex = (idx + 1) % total;
        return worker;
      }
    }

    return null;
  }

  /**
   * Handle a newly accepted public connection by piping it to an internal
   * worker port.
   */
  private handleConnection(clientSocket: WritableEnd & { data: ConnState }): void {
    const target = this.nextAliveWorker();
    if (!target) {
      clientSocket.end();
      return;
    }

    Bun.connect({
      hostname: '127.0.0.1',
      port: target.port,
      socket: {
        open: (upstream) => {
          clientSocket.data.upstream = upstream;

          // Flush any data that arrived before upstream was ready.
          for (const chunk of clientSocket.data.pending) {
            (upstream as unknown as WritableEnd).write(chunk);
          }
          clientSocket.data.pending.length = 0;
        },
        data: (_upstream, data) => {
          clientSocket.write(Buffer.from(data));
        },
        close: () => {
          clientSocket.end();
        },
        error: () => {
          clientSocket.end();
        },
      },
    });
  }
}
