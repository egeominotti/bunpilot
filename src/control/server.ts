// ---------------------------------------------------------------------------
// bunpm – Control Server: Unix-socket NDJSON server for CLI <-> daemon
// ---------------------------------------------------------------------------

import { unlinkSync, chmodSync, existsSync } from 'node:fs';
import type { ControlRequest, ControlResponse } from '../config/types';
import { encodeMessage, decodeMessages } from './protocol';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CommandHandler = (
  cmd: string,
  args: Record<string, unknown>,
) => Promise<ControlResponse>;

interface ClientState {
  buffer: string;
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

  constructor(socketPath: string, handler: CommandHandler) {
    this.socketPath = socketPath;
    this.handler = handler;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  async start(): Promise<void> {
    // Remove stale socket file if present
    this.cleanupSocket();

    this.server = Bun.listen({
      unix: this.socketPath,
      socket: {
        open: (socket) => {
          this.clients.set(socket, { buffer: '' });
        },

        data: (socket, raw) => {
          const state = this.clients.get(socket);
          if (!state) return;

          state.buffer += typeof raw === 'string' ? raw : new TextDecoder().decode(raw);

          // Process complete lines
          const lastNewline = state.buffer.lastIndexOf('\n');
          if (lastNewline === -1) return;

          const complete = state.buffer.slice(0, lastNewline + 1);
          state.buffer = state.buffer.slice(lastNewline + 1);

          const messages = decodeMessages(complete);
          for (const msg of messages) {
            this.handleRequest(socket, msg);
          }
        },

        close: (socket) => {
          this.clients.delete(socket);
        },

        error: (_socket, err) => {
          console.error('[control-server] socket error:', err.message);
        },
      },
    });

    // Restrict socket permissions to owner only
    try {
      chmodSync(this.socketPath, 0o600);
    } catch {
      // best-effort; may fail on some platforms
    }
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
    this.clients.clear();
    this.cleanupSocket();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private handleRequest(socket: { write(data: string | Uint8Array): number }, msg: object): void {
    const req = msg as Partial<ControlRequest>;

    if (!req.id || typeof req.id !== 'string' || !req.cmd || typeof req.cmd !== 'string') {
      const errorPayload = encodeMessage({
        id: req.id ?? 'unknown',
        ok: false,
        error: 'Invalid request: missing id or cmd',
      });
      socket.write(errorPayload);
      return;
    }

    const args = typeof req.args === 'object' && req.args !== null ? req.args : {};

    this.handler(req.cmd, args as Record<string, unknown>)
      .then((response) => {
        response.id = req.id!;
        try {
          socket.write(encodeMessage(response));
        } catch {
          // Client disconnected before response could be sent
        }
      })
      .catch((err) => {
        const errorMsg = err instanceof Error ? err.message : String(err);
        try {
          socket.write(
            encodeMessage({
              id: req.id,
              ok: false,
              error: errorMsg,
            }),
          );
        } catch {
          // Client disconnected before error could be sent
        }
      });
  }

  private cleanupSocket(): void {
    try {
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
      }
    } catch {
      // ignore – socket may already be removed
    }
  }
}
