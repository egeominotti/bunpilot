// ---------------------------------------------------------------------------
// bunpilot – Control Server: Unix-socket NDJSON server for CLI <-> daemon
// ---------------------------------------------------------------------------

import { chmodSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ControlRequest, ControlResponse } from '../config/types';
import { encodeMessage, MAX_CONTROL_FRAME_BYTES, NdjsonFramer } from './protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandHandler = (
  cmd: string,
  args: Record<string, unknown>,
) => Promise<ControlResponse>;

interface ClientState {
  framer: NdjsonFramer;
}

interface SocketIdentity {
  dev: number;
  ino: number;
}

// ---------------------------------------------------------------------------
// ControlServer
// ---------------------------------------------------------------------------

/**
 * Listens on a Unix domain socket for NDJSON-encoded `ControlRequest` messages
 * from CLI clients, dispatches them to the provided handler, and sends back
 * `ControlResponse` messages.
 *
 * - Supports multiple concurrent client connections.
 * - Socket file is chmod 0o600 so only the owning user can connect.
 */
export class ControlServer {
  private readonly socketPath: string;
  private readonly handler: CommandHandler;
  private server: ReturnType<typeof Bun.listen> | null = null;
  private readonly clients = new Map<object, ClientState>();
  private socketIdentity: SocketIdentity | null = null;

  constructor(socketPath: string, handler: CommandHandler) {
    this.socketPath = socketPath;
    this.handler = handler;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.server) throw new Error('control server is already running');
    mkdirSync(dirname(this.socketPath), { recursive: true });
    await this.prepareSocketPath();

    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open: (socket) => {
          this.clients.set(socket, { framer: new NdjsonFramer() });
        },

        data: (socket, raw) => {
          const state = this.clients.get(socket);
          if (!state) return;

          try {
            for (const msg of state.framer.push(raw)) {
              this.handleRequest(socket, msg);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid control frame';
            try {
              socket.write(encodeMessage({ id: 'unknown', ok: false, error: message }));
              socket.end();
            } catch {
              // Connection may already be closed.
            }
          }
        },

        close: (socket) => {
          this.clients.delete(socket);
        },

        error: (socket, err) => {
          console.error('[control-server] socket error:', err.message);
          this.clients.delete(socket);
        },
      },
    });

    // Restrict socket permissions to owner only. Failing closed is important:
    // this socket is the daemon's administrative trust boundary.
    try {
      chmodSync(this.socketPath, 0o600);
      const stat = lstatSync(this.socketPath);
      this.socketIdentity = { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      this.server.stop(true);
      this.server = null;
      this.removeOwnedSocket();
      throw error;
    }
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
    this.clients.clear();
    this.removeOwnedSocket();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private handleRequest(socket: { write(data: string | Uint8Array): number }, msg: object): void {
    const req = msg as Partial<ControlRequest>;

    if (
      !req.id ||
      typeof req.id !== 'string' ||
      req.id.length > 128 ||
      !req.cmd ||
      typeof req.cmd !== 'string' ||
      req.cmd.length > 64
    ) {
      const errorPayload = encodeMessage({
        id: typeof req.id === 'string' && req.id.length <= 128 ? req.id : 'unknown',
        ok: false,
        error: 'Invalid request: missing id or cmd',
      });
      socket.write(errorPayload);
      return;
    }

    const args =
      typeof req.args === 'object' && req.args !== null && !Array.isArray(req.args) ? req.args : {};

    const requestId = req.id;
    this.handler(req.cmd, args as Record<string, unknown>)
      .then((response) => {
        try {
          socket.write(this.encodeBoundedResponse(requestId, response));
        } catch {
          // Client disconnected before response could be sent
        }
      })
      .catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        try {
          socket.write(
            this.encodeBoundedResponse(requestId, { id: requestId, ok: false, error: errorMsg }),
          );
        } catch {
          // Client disconnected before error could be sent
        }
      });
  }

  private async prepareSocketPath(): Promise<void> {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(this.socketPath);
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }

    if (!stat.isSocket()) {
      throw new Error(`Control socket path exists and is not a Unix socket: ${this.socketPath}`);
    }
    if (await isUnixSocketReachable(this.socketPath)) {
      throw new Error(`Control socket is already in use: ${this.socketPath}`);
    }
    unlinkSync(this.socketPath);
  }

  private removeOwnedSocket(): void {
    const identity = this.socketIdentity;
    this.socketIdentity = null;
    if (!identity) return;
    try {
      const stat = lstatSync(this.socketPath);
      if (stat.isSocket() && stat.dev === identity.dev && stat.ino === identity.ino) {
        unlinkSync(this.socketPath);
      }
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }

  private encodeBoundedResponse(id: string, response: ControlResponse): string {
    let payload: string;
    try {
      payload = encodeMessage({ ...response, id });
    } catch {
      payload = encodeMessage({ id, ok: false, error: 'Control response is not serializable' });
    }
    if (new TextEncoder().encode(payload).byteLength <= MAX_CONTROL_FRAME_BYTES) return payload;
    return encodeMessage({
      id,
      ok: false,
      error: `Control response exceeds ${MAX_CONTROL_FRAME_BYTES} bytes`,
    });
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function isUnixSocketReachable(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let connectedSocket: { end(): void } | null = null;
    const finish = (reachable: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(reachable);
    };
    const timer = setTimeout(() => {
      try {
        connectedSocket?.end();
      } catch {
        // The probe may already have been closed by the peer.
      }
      finish(true);
    }, 500);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          connectedSocket = socket;
          finish(true);
          socket.end();
        },
        data() {},
        close() {
          finish(false);
        },
        error() {
          finish(false);
        },
      },
    }).catch(() => finish(false));
  });
}
