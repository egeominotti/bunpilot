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
 * Minimal interface for the Bun sockets we pipe between.
 *
 * We only touch `write`/`end`/`pause`/`resume`, and we cast to this interface
 * at the call sites because Bun's internal Socket type uses `Bun.BufferSource`
 * which is structurally incompatible with the standard DOM `BufferSource`.
 *
 * `write` follows Bun's contract: it writes only what the kernel accepts *right
 * now* and returns that count — it does NOT buffer the remainder. `pause`
 * stops read events on the socket so the peer feels TCP backpressure; `resume`
 * re-enables them.
 */
interface DuplexSocket {
  write(data: Buffer): number;
  end(): void;
  pause(): void;
  resume(): void;
}

/**
 * One direction of a proxied connection: bytes accepted from a *source* socket
 * that still owe delivery to a *sink* socket.
 *
 * When a `sink.write` goes short we retain the un-accepted tail here (in
 * arrival order) and pause the source so no further bytes are read until the
 * sink emits `drain` and we can flush. This is what guarantees CL-12 — "every
 * byte accepted from one side is delivered to the other exactly once, in
 * arrival order" — instead of silently dropping the tail of a partial write.
 */
interface Channel {
  /** Un-flushed bytes, oldest first. */
  queue: Buffer[];
  /** Total bytes currently held in `queue`. */
  bytes: number;
  /** True while we've paused the source feeding this channel. */
  sourcePaused: boolean;
}

/**
 * Per-connection state attached to each public-facing socket.
 */
interface ConnState {
  /** The public-facing client socket. */
  client: DuplexSocket | null;
  /** The internal worker socket, once `Bun.connect` has opened it. */
  upstream: DuplexSocket | null;
  /** Set once the public client socket closes/errors. */
  clientClosed: boolean;
  /** Bytes flowing client -> upstream (buffered before/around backpressure). */
  toUpstream: Channel;
  /** Bytes flowing upstream -> client (buffered around backpressure). */
  toClient: Channel;
  /** Upstream finished; `end()` the client once `toClient` fully drains. */
  endClientWhenFlushed: boolean;
  /** Client finished; `end()` the upstream once `toUpstream` fully drains. */
  endUpstreamWhenFlushed: boolean;
}

function makeChannel(): Channel {
  return { queue: [], bytes: 0, sourcePaused: false };
}

// ---------------------------------------------------------------------------
// ProxyCluster
// ---------------------------------------------------------------------------

/**
 * A userland TCP proxy that load-balances connections across worker processes
 * using simple round-robin.
 */
export class ProxyCluster {
  /**
   * Per-direction, per-connection buffer bound. Real backpressure comes from
   * pausing the source socket; this cap is the last-resort safety net. It sits
   * well above the pause "lag" — `Socket.pause()` is not instantaneous, so up
   * to a socket-receive-buffer's worth of already-read bytes can still arrive
   * (and must be queued) after we pause — yet far below any realistic stream
   * size, so genuinely unbounded growth still fails the connection closed
   * instead of buffering without limit or silently dropping the tail.
   */
  private static readonly MAX_PENDING_BYTES = 8 * 1024 * 1024;
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
          const state: ConnState = {
            client: socket as unknown as DuplexSocket,
            upstream: null,
            clientClosed: false,
            toUpstream: makeChannel(),
            toClient: makeChannel(),
            endClientWhenFlushed: false,
            endUpstreamWhenFlushed: false,
          };
          socket.data = state;
          this.handleConnection(socket as unknown as DuplexSocket & { data: ConnState });
        },
        data: (socket, data) => {
          const state = socket.data;
          // client -> upstream. Honour backpressure: queue any tail the
          // upstream can't accept yet and pause reads from the client.
          const ok = this.pushToChannel(
            state.toUpstream,
            state.upstream,
            state.client,
            Buffer.from(data),
          );
          if (!ok) this.destroyConn(state);
        },
        drain: (socket) => {
          const state = socket.data;
          // The client socket drained: flush whatever we still owe it and, once
          // empty, resume reads from the upstream.
          this.flushChannel(state.toClient, state.client, state.upstream);
          if (state.endClientWhenFlushed && state.toClient.queue.length === 0) {
            state.client?.end();
            state.client = null;
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

  /**
   * Remove a worker so the proxy stops sending it traffic.
   *
   * CL-06: retired ids must be *reclaimed*, not merely flipped to `alive=false`.
   * A long-lived daemon performs a fresh-id rolling reload on every restart, so
   * leaving dead slots in the map lets `workers`/`sortedWorkerIds` grow without
   * bound. Deleting the slot keeps the exposed worker-id set bounded by the
   * app's concurrently-configured instance count. Round-robin over the
   * remaining alive slots is unaffected (`nextAliveWorker` re-derives from the
   * live map every time).
   */
  removeWorker(workerId: number): void {
    if (this.workers.delete(workerId)) {
      this.rebuildSortedWorkerIds();
    }
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
    // Keep the round-robin cursor within bounds after the id set shrinks.
    if (this.sortedWorkerIds.length === 0) {
      this.rrIndex = 0;
    } else if (this.rrIndex >= this.sortedWorkerIds.length) {
      this.rrIndex %= this.sortedWorkerIds.length;
    }
  }

  // -----------------------------------------------------------------------
  // Backpressure-aware piping
  // -----------------------------------------------------------------------

  /**
   * Write `chunk` toward `sink`, preserving arrival order. Any tail the sink
   * can't accept right now is queued and `source` is paused so no more bytes
   * are read until the sink drains.
   *
   * Returns `false` when the channel exceeded its bound (the caller must fail
   * the connection closed rather than buffer unboundedly).
   */
  private pushToChannel(
    channel: Channel,
    sink: DuplexSocket | null,
    source: DuplexSocket | null,
    chunk: Buffer,
  ): boolean {
    if (chunk.byteLength === 0) return true;

    let tail = chunk;
    // Only write straight through when nothing is already queued — otherwise we
    // would reorder bytes ahead of the pending tail.
    if (channel.queue.length === 0 && sink) {
      const n = sink.write(chunk);
      if (n >= chunk.byteLength) return true;
      tail = n > 0 ? chunk.subarray(n) : chunk;
    }

    channel.queue.push(tail);
    channel.bytes += tail.byteLength;

    if (source && !channel.sourcePaused) {
      source.pause();
      channel.sourcePaused = true;
    }

    return channel.bytes <= ProxyCluster.MAX_PENDING_BYTES;
  }

  /**
   * Flush a channel's queued bytes toward `sink` after a `drain`. Stops at the
   * first short write (keeping `source` paused); once the queue empties it
   * resumes `source` so reads can continue.
   */
  private flushChannel(
    channel: Channel,
    sink: DuplexSocket | null,
    source: DuplexSocket | null,
  ): void {
    if (!sink) return;

    while (channel.queue.length > 0) {
      const head = channel.queue[0];
      const n = sink.write(head);
      if (n > 0) channel.bytes -= n;
      if (n >= head.byteLength) {
        channel.queue.shift();
      } else {
        if (n > 0) channel.queue[0] = head.subarray(n);
        return; // still blocked — keep the source paused
      }
    }

    if (channel.sourcePaused && source) {
      source.resume();
      channel.sourcePaused = false;
    }
  }

  /** Fail a connection closed, dropping both buffers and ending both sockets. */
  private destroyConn(state: ConnState): void {
    state.clientClosed = true;
    try {
      state.upstream?.end();
    } catch {
      /* upstream may already be closed */
    }
    try {
      state.client?.end();
    } catch {
      /* client may already be closed */
    }
    state.upstream = null;
    state.client = null;
    state.toUpstream.queue.length = 0;
    state.toUpstream.bytes = 0;
    state.toClient.queue.length = 0;
    state.toClient.bytes = 0;
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
    state.client = null;

    // Bytes still owed *to* the client are now undeliverable — drop them.
    state.toClient.queue.length = 0;
    state.toClient.bytes = 0;

    // Bytes we already accepted *from* the client must still reach the upstream
    // (deliver-exactly-once holds for the side that is still open). Flush what
    // we can, then close the upstream once its queue drains.
    if (state.upstream) {
      this.flushChannel(state.toUpstream, state.upstream, null);
      if (state.toUpstream.queue.length === 0) {
        state.upstream.end();
        state.upstream = null;
      } else {
        state.endUpstreamWhenFlushed = true;
      }
    } else {
      state.toUpstream.queue.length = 0;
      state.toUpstream.bytes = 0;
    }
  }

  /**
   * Handle a newly accepted public connection by piping it to an internal
   * worker port.
   */
  private handleConnection(clientSocket: DuplexSocket & { data: ConnState }): void {
    const clientState = clientSocket.data;
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
          const upstreamSocket = upstream as unknown as DuplexSocket;
          // H5: the client may have closed while we were connecting upstream.
          // If so, drop the upstream immediately — don't adopt or flush to it.
          if (clientState.clientClosed) {
            upstreamSocket.end();
            return;
          }

          clientState.upstream = upstreamSocket;

          // Flush any data that arrived before upstream was ready, honouring
          // upstream backpressure. If the flush can't complete, the client
          // stays paused until the upstream drains.
          this.flushChannel(clientState.toUpstream, upstreamSocket, clientState.client);
        },
        data: (_upstream, data) => {
          // Client already gone: bytes from upstream have nowhere to go.
          if (!clientState.client) return;
          // upstream -> client. Queue any tail the client can't accept yet and
          // pause reads from the upstream.
          const ok = this.pushToChannel(
            clientState.toClient,
            clientState.client,
            clientState.upstream,
            Buffer.from(data),
          );
          if (!ok) this.destroyConn(clientState);
        },
        drain: () => {
          // The upstream socket drained: flush whatever we still owe it and,
          // once empty, resume reads from the client.
          this.flushChannel(clientState.toUpstream, clientState.upstream, clientState.client);
          if (clientState.endUpstreamWhenFlushed && clientState.toUpstream.queue.length === 0) {
            clientState.upstream?.end();
            clientState.upstream = null;
          }
        },
        close: () => {
          // Upstream finished sending. Deliver everything still owed to the
          // client before closing it — a half-close must not drop the tail.
          clientState.upstream = null;
          this.flushChannel(clientState.toClient, clientState.client, null);
          if (clientState.toClient.queue.length === 0) {
            clientState.client?.end();
            clientState.client = null;
          } else {
            clientState.endClientWhenFlushed = true;
          }
        },
        error: () => {
          // Upstream broke mid-stream: we can't trust the remainder, so tear
          // the client down immediately.
          clientState.upstream = null;
          clientState.client?.end();
          clientState.client = null;
        },
      },
    }).catch(() => {
      // Upstream connection failed – close the client socket to prevent leak.
      try {
        clientState.client?.end();
      } catch {
        /* client may already be closed */
      }
    });
  }
}
