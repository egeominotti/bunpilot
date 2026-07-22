// ---------------------------------------------------------------------------
// bunpilot – Control Client: connects to daemon Unix socket over NDJSON
// ---------------------------------------------------------------------------

import { existsSync } from 'node:fs';
import type { ControlResponse, ControlStreamChunk } from '../config/types';
import { createRequest, encodeMessage, NdjsonFramer } from './protocol';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000;

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

/**
 * Build a stateful NDJSON line framer over a socket's `data` chunks.
 *
 * Buffers partial input and, on each call, returns the decoded messages for
 * any *complete* lines received so far (leaving a trailing partial line
 * buffered). Shared by `send` and `sendStream` so the buffering logic lives in
 * exactly one place.
 */
function createLineFramer(): (raw: string | Uint8Array) => object[] {
  const framer = new NdjsonFramer();
  return (raw) => framer.push(raw);
}

// ---------------------------------------------------------------------------
// ControlClient
// ---------------------------------------------------------------------------

/**
 * Connects to the bunpilot daemon over a Unix domain socket, sends a command,
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
      const frame = createLineFramer();
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
            try {
              s.write(payload);
            } catch (err) {
              settle(() => reject(err instanceof Error ? err : new Error(String(err))));
            }
          },

          data(s, raw) {
            try {
              for (const msg of frame(raw)) {
                if (isControlResponse(msg) && msg.id === req.id) {
                  settle(() => resolve(msg));
                  s.end();
                  return;
                }
              }
            } catch (error) {
              settle(() => reject(error instanceof Error ? error : new Error(String(error))));
              s.end();
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
      const frame = createLineFramer();
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      const armIdleTimeout = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          settle(() =>
            reject(new Error(`Stream idle timeout after ${DEFAULT_STREAM_IDLE_TIMEOUT_MS}ms`)),
          );
          streamSocket?.end();
        }, DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      };

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        fn();
      };

      let streamSocket: { end(): void } | null = null;

      Bun.connect({
        unix: this.socketPath,
        socket: {
          open(s) {
            streamSocket = s;
            try {
              s.write(payload);
              armIdleTimeout();
            } catch (error) {
              settle(() => reject(error instanceof Error ? error : new Error(String(error))));
            }
          },

          data(_s, raw) {
            let messages: object[];
            try {
              messages = frame(raw);
            } catch (error) {
              settle(() => reject(error instanceof Error ? error : new Error(String(error))));
              streamSocket?.end();
              return;
            }
            armIdleTimeout();
            for (const msg of messages) {
              if (isStreamChunk(msg) && msg.id === req.id) {
                try {
                  onChunk(msg);
                } catch (error) {
                  settle(() => reject(error instanceof Error ? error : new Error(String(error))));
                  streamSocket?.end();
                  return;
                }
                if (msg.done) {
                  settle(() => resolve());
                  try {
                    streamSocket?.end();
                  } catch {
                    /* socket may already be closed */
                  }
                  return;
                }
              } else if (isControlResponse(msg) && msg.id === req.id && !msg.ok) {
                // Server sent an error response instead of a stream
                settle(() => reject(new Error(msg.error ?? 'Unknown error')));
                try {
                  streamSocket?.end();
                } catch {
                  /* socket may already be closed */
                }
                return;
              }
            }
          },

          close() {
            // A stream may legitimately contain zero chunks; peer close is EOF.
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
      throw new Error(`bunpilot daemon is not running (socket not found at ${this.socketPath})`);
    }
  }
}
