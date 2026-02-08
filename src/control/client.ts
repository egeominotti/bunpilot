// ---------------------------------------------------------------------------
// bunpm – Control Client: connects to daemon Unix socket over NDJSON
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import type { ControlResponse, ControlStreamChunk } from '../config/types';
import { encodeMessage, createRequest, decodeMessages } from './protocol';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDaemonRunning(socketPath: string): boolean {
  return existsSync(socketPath);
}

function isStreamChunk(msg: object): msg is ControlStreamChunk {
  return 'stream' in msg && (msg as ControlStreamChunk).stream === true;
}

function isControlResponse(msg: object): msg is ControlResponse {
  return 'ok' in msg && typeof (msg as ControlResponse).ok === 'boolean';
}

// ---------------------------------------------------------------------------
// ControlClient
// ---------------------------------------------------------------------------

/**
 * Connects to the bunpm daemon over a Unix domain socket, sends a command,
 * and returns the response.  Each `send()` call opens a fresh connection
 * so there is no long-lived state to manage.
 */
export class ControlClient {
  private readonly socketPath: string;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  // -----------------------------------------------------------------------
  // send – single request / response
  // -----------------------------------------------------------------------

  /**
   * Send a command and wait for a single `ControlResponse`.
   * Throws if the daemon is not running or the request times out.
   */
  async send(cmd: string, args?: Record<string, unknown>): Promise<ControlResponse> {
    this.ensureDaemonRunning();

    const req = createRequest(cmd, args);
    const payload = encodeMessage(req);

    return new Promise<ControlResponse>((resolve, reject) => {
      let buffer = '';
      let settled = false;
      let socket: ReturnType<typeof Bun.connect> extends Promise<infer S> ? S : never;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`Request timed out after ${DEFAULT_TIMEOUT_MS}ms`));
        try {
          socket?.end();
        } catch {
          /* ignore */
        }
      }, DEFAULT_TIMEOUT_MS);

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      Bun.connect({
        unix: this.socketPath,
        socket: {
          open(s) {
            socket = s;
            s.write(payload);
          },

          data(_s, raw) {
            buffer += typeof raw === 'string' ? raw : new TextDecoder().decode(raw);

            const messages = decodeMessages(buffer);
            if (messages.length === 0) return;

            // We only expect one response per send()
            const msg = messages[0];
            if (isControlResponse(msg)) {
              settle(() => resolve(msg));
            }
          },

          close() {
            settle(() => reject(new Error('Connection closed before receiving a response')));
          },

          error(_s, err) {
            settle(() => reject(err));
          },
        },
      }).catch((err) => {
        settle(() => reject(err));
      });
    });
  }

  // -----------------------------------------------------------------------
  // sendStream – streaming request (logs, monit)
  // -----------------------------------------------------------------------

  /**
   * Send a command that produces a stream of `ControlStreamChunk` messages.
   * `onChunk` is called for each chunk; the promise resolves when the server
   * sends a chunk with `done: true` or the connection closes.
   *
   * This method does NOT apply a timeout (streams are long-lived by nature).
   */
  async sendStream(
    cmd: string,
    args: Record<string, unknown> | undefined,
    onChunk: (chunk: ControlStreamChunk) => void,
  ): Promise<void> {
    this.ensureDaemonRunning();

    const req = createRequest(cmd, args);
    const payload = encodeMessage(req);

    return new Promise<void>((resolve, reject) => {
      let buffer = '';
      let settled = false;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        fn();
      };

      Bun.connect({
        unix: this.socketPath,
        socket: {
          open(s) {
            s.write(payload);
          },

          data(_s, raw) {
            buffer += typeof raw === 'string' ? raw : new TextDecoder().decode(raw);

            const lastNewline = buffer.lastIndexOf('\n');
            if (lastNewline === -1) return;

            const complete = buffer.slice(0, lastNewline + 1);
            buffer = buffer.slice(lastNewline + 1);

            const messages = decodeMessages(complete);
            for (const msg of messages) {
              if (isStreamChunk(msg)) {
                onChunk(msg);
                if (msg.done) {
                  settle(() => resolve());
                  return;
                }
              } else if (isControlResponse(msg) && !msg.ok) {
                // Server sent an error response instead of a stream
                settle(() => reject(new Error(msg.error ?? 'Unknown error')));
                return;
              }
            }
          },

          close() {
            // Stream ended by server closing the connection – normal exit
            settle(() => resolve());
          },

          error(_s, err) {
            settle(() => reject(err));
          },
        },
      }).catch((err) => {
        settle(() => reject(err));
      });
    });
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private ensureDaemonRunning(): void {
    if (!isDaemonRunning(this.socketPath)) {
      throw new Error(`bunpm daemon is not running (socket not found at ${this.socketPath})`);
    }
  }
}
