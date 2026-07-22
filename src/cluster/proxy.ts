// ---------------------------------------------------------------------------
// bunpilot – TCP Proxy Cluster (macOS / non-reusePort platforms)
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
  pendingBytes: number;
  /** Set once the public client socket closes/errors. */
  clientClosed: boolean;
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
  private static readonly MAX_PENDING_BYTES = 1024 * 1024;
  /** Worker slots keyed by workerId. Supports non-contiguous IDs for replacement workers. */
  private workers: Map<number, WorkerSlot> = new Map();

  /** Cached sorted list of worker IDs. Rebuilt only when workers are added/removed. */
  private sortedWorkerIds: number[] = [];

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
  start(publicPort: number, workerCount: number, workerPorts?: ReadonlyMap<number, number>): void {
    if (this.listener) {
      throw new Error('proxy is already running');
    }
    this.workers = new Map();
    for (let i = 0; i < workerCount; i++) {
      this.workers.set(i, { port: workerPorts?.get(i) ?? INTERNAL_PORT_BASE + i, alive: false });
    }

    this.rrIndex = 0;
    this.rebuildSortedWorkerIds();

    this.listener = Bun.listen<ConnState>({
      hostname: '0.0.0.0',
      port: publicPort,
      socket: {
        open: (socket) => {
          socket.data = { upstream: null, pending: [], pendingBytes: 0, clientClosed: false };
          this.handleConnection(socket as unknown as WritableEnd & { data: ConnState });
        },
        data: (socket, data) => {
          const state = socket.data;
          if (state.upstream) {
            (state.upstream as WritableEnd).write(Buffer.from(data));
          } else {
            const chunk = Buffer.from(data);
            state.pendingBytes += chunk.byteLength;
            if (state.pendingBytes > ProxyCluster.MAX_PENDING_BYTES) {
              state.pending.length = 0;
              socket.end();
              return;
            }
            state.pending.push(chunk);
          }
        },
        close: (socket) => {
          this.onClientGone(socket.data);
        },
        error: (socket) => {
          this.onClientGone(socket.data);
        },
      },
    });
  }

  /** Mark worker as alive so the proxy starts sending it traffic. */
  addWorker(workerId: number, portOverride?: number): void {
    const slot = this.workers.get(workerId);
    if (slot) {
      if (portOverride !== undefined) slot.port = portOverride;
      slot.alive = true;
    } else {
      // Replacement worker with a new ID – create a slot dynamically.
      this.workers.set(workerId, {
        port: portOverride ?? INTERNAL_PORT_BASE + workerId,
        alive: true,
      });
    }
    this.rebuildSortedWorkerIds();
  }

  /** Mark worker as dead so the proxy stops sending it traffic. */
  removeWorker(workerId: number): void {
    const slot = this.workers.get(workerId);
    if (slot) {
      slot.alive = false;
    }
    this.rebuildSortedWorkerIds();
  }

  /** Stop the public listener and release all resources. */
  stop(): void {
    if (this.listener) {
      this.listener.stop(true);
      this.listener = null;
    }
    this.workers = new Map();
    this.sortedWorkerIds = [];
    this.rrIndex = 0;
  }

  // -----------------------------------------------------------------------
  // Cache management
  // -----------------------------------------------------------------------

  /** Rebuild the cached sorted worker ID list from the current workers map. */
  private rebuildSortedWorkerIds(): void {
    this.sortedWorkerIds = Array.from(this.workers.keys()).sort((a, b) => a - b);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  /**
   * Pick the next alive worker using round-robin.
   * Returns `null` when no workers are alive.
   */
  private nextAliveWorker(): WorkerSlot | null {
    const ids = this.sortedWorkerIds;
    const total = ids.length;
    if (total === 0) return null;

    for (let i = 0; i < total; i++) {
      const idx = (this.rrIndex + i) % total;
      const worker = this.workers.get(ids[idx]);
      if (worker?.alive) {
        this.rrIndex = (idx + 1) % total;
        return worker;
      }
    }

    return null;
  }

  /**
   * Record that the public client socket is gone and tear down its upstream.
   *
   * H5: the client can disconnect *before* the async `Bun.connect` upstream
   * opens. Marking `clientClosed` lets the upstream `open` handler immediately
   * release the just-connected worker socket instead of leaking a half-open FD.
   */
  private onClientGone(state: ConnState | undefined): void {
    if (!state) return;
    state.clientClosed = true;
    if (state.upstream) {
      (state.upstream as WritableEnd).end();
      state.upstream = null;
    }
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
          // H5: the client may have closed while we were connecting upstream.
          // If so, drop the upstream immediately — don't adopt or flush to it.
          if (clientSocket.data.clientClosed) {
            (upstream as unknown as WritableEnd).end();
            return;
          }

          clientSocket.data.upstream = upstream;

          // Flush any data that arrived before upstream was ready.
          for (const chunk of clientSocket.data.pending) {
            (upstream as unknown as WritableEnd).write(chunk);
          }
          clientSocket.data.pending.length = 0;
          clientSocket.data.pendingBytes = 0;
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
    }).catch(() => {
      // Upstream connection failed – close the client socket to prevent leak.
      try {
        clientSocket.end();
      } catch {
        /* client may already be closed */
      }
    });
  }
}
