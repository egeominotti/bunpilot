// ---------------------------------------------------------------------------
// bunpilot – SocketWriter: backpressure-aware writer for Bun sockets
// ---------------------------------------------------------------------------

import { MAX_CONTROL_FRAME_BYTES } from '../control/protocol';

/**
 * The subset of Bun's `Socket` this writer needs. Bun's `Socket.write` returns
 * the number of bytes the kernel accepted and does NOT buffer the remainder, so
 * a caller that ignores the return value silently truncates any payload larger
 * than the socket send buffer (as small as 8 KiB on a unix SOCK_STREAM).
 */
export interface WritableSocket {
  write(data: Uint8Array): number;
  end(): void;
}

const EMPTY = new Uint8Array(0);
const ENCODER = new TextEncoder();

/**
 * Per-socket buffered writer that guarantees a payload is transmitted in full.
 *
 * `write()` appends bytes to a pending queue and flushes as much as the socket
 * accepts; any un-accepted tail is retained and re-flushed when the socket's
 * `drain` event fires. Total buffered bytes are bounded to
 * `MAX_CONTROL_FRAME_BYTES`; on overflow the writer fails closed (ends the
 * socket) rather than growing without bound.
 */
export class SocketWriter {
  private readonly socket: WritableSocket;
  private readonly maxBufferedBytes: number;
  private pending: Uint8Array = EMPTY;
  private closed = false;

  constructor(socket: WritableSocket, maxBufferedBytes: number = MAX_CONTROL_FRAME_BYTES) {
    this.socket = socket;
    this.maxBufferedBytes = maxBufferedBytes;
  }

  /**
   * Queue `data` for delivery and flush as much as the socket will accept.
   * Returns `false` if the writer has failed closed (buffer overflow or the
   * socket rejected a write); `true` while the payload is still deliverable.
   */
  write(data: string | Uint8Array): boolean {
    if (this.closed) return false;
    const bytes = typeof data === 'string' ? ENCODER.encode(data) : data;
    if (bytes.byteLength === 0) return true;
    this.enqueue(bytes);
    if (this.closed) return false;
    this.flush();
    return !this.closed;
  }

  /**
   * Re-attempt delivery of any buffered tail. Wire this to the socket's
   * `drain` event so backpressure is relieved as the kernel drains its buffer.
   */
  flush(): void {
    if (this.closed || this.pending.byteLength === 0) return;

    let accepted: number;
    try {
      accepted = this.socket.write(this.pending);
    } catch {
      // The socket was closed underneath us; nothing more can be delivered.
      this.closed = true;
      this.pending = EMPTY;
      return;
    }

    if (accepted >= this.pending.byteLength) {
      this.pending = EMPTY;
    } else if (accepted > 0) {
      // Retain the un-accepted tail; `drain` will re-drive this flush.
      this.pending = this.pending.subarray(accepted);
    }
    // accepted <= 0: the send buffer is full — keep everything and wait for drain.
  }

  private enqueue(bytes: Uint8Array): void {
    if (this.pending.byteLength === 0) {
      this.pending = bytes;
    } else {
      const combined = new Uint8Array(this.pending.byteLength + bytes.byteLength);
      combined.set(this.pending, 0);
      combined.set(bytes, this.pending.byteLength);
      this.pending = combined;
    }

    if (this.pending.byteLength > this.maxBufferedBytes) {
      // Fail closed: the peer is not draining fast enough to bound memory.
      this.closed = true;
      this.pending = EMPTY;
      try {
        this.socket.end();
      } catch {
        // Socket may already be closed.
      }
    }
  }
}
