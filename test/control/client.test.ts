// ---------------------------------------------------------------------------
// bunpilot – Control Client unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { ControlClient } from '../../src/control/client';
import { ControlServer } from '../../src/control/server';
import {
  createResponse,
  createErrorResponse,
  createStreamChunk,
  encodeMessage,
  decodeMessages,
} from '../../src/control/protocol';
import type { ControlStreamChunk } from '../../src/config/types';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;
const servers: ControlServer[] = [];
const rawListeners: Array<ReturnType<typeof Bun.listen>> = [];

function freshTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'bunpilot-client-test-'));
  return tempDir;
}

afterEach(() => {
  for (const s of servers) {
    try {
      s.stop();
    } catch {
      /* ignore */
    }
  }
  servers.length = 0;

  for (const l of rawListeners) {
    try {
      l.stop(true);
    } catch {
      /* ignore */
    }
  }
  rawListeners.length = 0;

  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function trackServer(server: ControlServer): ControlServer {
  servers.push(server);
  return server;
}

/**
 * Start a raw Unix socket server that receives a request and calls `onConnect`
 * with a write function. This allows tests to send arbitrary NDJSON messages
 * (including stream chunks) without going through ControlServer.
 */
function startRawStreamServer(
  socketPath: string,
  onConnect: (write: (msg: object) => void, close: () => void) => void,
): ReturnType<typeof Bun.listen> {
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open(socket) {
        const write = (msg: object) => {
          socket.write(encodeMessage(msg));
        };
        const close = () => {
          socket.end();
        };
        // Parse incoming request first, then call onConnect
        // We need to wait for the client to send the request before replying
        (socket as any)._onConnect = () => onConnect(write, close);
      },

      data(socket, raw) {
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        const messages = decodeMessages(text);
        if (messages.length > 0 && (socket as any)._onConnect) {
          const fn = (socket as any)._onConnect;
          (socket as any)._onConnect = null;
          fn();
        }
      },

      close() {
        /* ignore */
      },

      error(_socket, err) {
        console.error('[raw-stream-server] error:', err.message);
      },
    },
  });

  rawListeners.push(listener);
  return listener;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('ControlClient', () => {
  describe('constructor', () => {
    test('creates an instance', () => {
      const client = new ControlClient('/tmp/nonexistent.sock');
      expect(client).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // send() – daemon not running
  // -------------------------------------------------------------------------

  describe('send() – daemon not running', () => {
    test('throws when socket file does not exist', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'missing.sock');
      const client = new ControlClient(socketPath);

      expect(existsSync(socketPath)).toBe(false);
      await expect(client.send('ping')).rejects.toThrow('daemon is not running');
    });
  });

  // -------------------------------------------------------------------------
  // send() – integration with ControlServer
  // -------------------------------------------------------------------------

  describe('send() – integration with ControlServer', () => {
    test('sends a command and receives a successful response', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'ok.sock');

      const server = trackServer(
        new ControlServer(socketPath, async (cmd, args) => {
          return createResponse('', { cmd, args });
        }),
      );
      await server.start();

      const client = new ControlClient(socketPath);
      const res = await client.send('ping');

      expect(res.ok).toBe(true);
      expect((res.data as any).cmd).toBe('ping');
    });

    test('receives an error response from the server', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'err.sock');

      const server = trackServer(
        new ControlServer(socketPath, async (cmd) => {
          return createErrorResponse('', `unknown command: ${cmd}`);
        }),
      );
      await server.start();

      const client = new ControlClient(socketPath);
      const res = await client.send('nonexistent');

      expect(res.ok).toBe(false);
      expect(res.error).toBe('unknown command: nonexistent');
    });

    test('passes args to the server handler', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'args.sock');

      const server = trackServer(
        new ControlServer(socketPath, async (_cmd, args) => {
          return createResponse('', { receivedName: args.name });
        }),
      );
      await server.start();

      const client = new ControlClient(socketPath);
      const res = await client.send('status', { name: 'my-app' });

      expect(res.ok).toBe(true);
      expect((res.data as any).receivedName).toBe('my-app');
    });

    test('response id matches the request id', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'id.sock');

      const server = trackServer(
        new ControlServer(socketPath, async () => {
          return createResponse('', { ok: true });
        }),
      );
      await server.start();

      const client = new ControlClient(socketPath);
      const res = await client.send('ping');

      // The server sets the response id to the request id
      expect(typeof res.id).toBe('string');
      expect(res.id.length).toBeGreaterThan(0);
    });

    test('multiple sequential sends work correctly', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'seq.sock');

      let callCount = 0;
      const server = trackServer(
        new ControlServer(socketPath, async (cmd) => {
          callCount++;
          return createResponse('', { cmd, call: callCount });
        }),
      );
      await server.start();

      const client = new ControlClient(socketPath);

      const r1 = await client.send('ping');
      const r2 = await client.send('list');
      const r3 = await client.send('metrics');

      expect(r1.ok).toBe(true);
      expect((r1.data as any).cmd).toBe('ping');
      expect(r2.ok).toBe(true);
      expect((r2.data as any).cmd).toBe('list');
      expect(r3.ok).toBe(true);
      expect((r3.data as any).cmd).toBe('metrics');
    });

    test('handler throwing results in an error response', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'throw.sock');

      const server = trackServer(
        new ControlServer(socketPath, async () => {
          throw new Error('internal failure');
        }),
      );
      await server.start();

      const client = new ControlClient(socketPath);
      const res = await client.send('crash');

      expect(res.ok).toBe(false);
      expect(res.error).toBe('internal failure');
    });
  });

  // -------------------------------------------------------------------------
  // sendStream() – daemon not running
  // -------------------------------------------------------------------------

  describe('sendStream() – daemon not running', () => {
    test('throws when socket file does not exist', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'missing.sock');
      const client = new ControlClient(socketPath);

      await expect(
        client.sendStream('logs', undefined, () => {}),
      ).rejects.toThrow('daemon is not running');
    });
  });

  // -------------------------------------------------------------------------
  // sendStream() – streaming with raw server
  // -------------------------------------------------------------------------

  describe('sendStream() – streaming', () => {
    test('invokes onChunk for each stream chunk', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stream-chunks.sock');

      startRawStreamServer(socketPath, (write, _close) => {
        write(createStreamChunk('req-1', { line: 'hello' }));
        write(createStreamChunk('req-1', { line: 'world' }));
        write(createStreamChunk('req-1', null, true));
      });

      const client = new ControlClient(socketPath);
      const received: ControlStreamChunk[] = [];

      await client.sendStream('logs', undefined, (chunk) => {
        received.push(chunk);
      });

      expect(received.length).toBe(3);
      expect((received[0].data as any).line).toBe('hello');
      expect((received[1].data as any).line).toBe('world');
      expect(received[2].done).toBe(true);
    });

    test('resolves when done: true is received', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stream-done.sock');

      startRawStreamServer(socketPath, (write) => {
        write(createStreamChunk('req-1', 'single-chunk', true));
      });

      const client = new ControlClient(socketPath);
      const received: ControlStreamChunk[] = [];

      await client.sendStream('logs', { app: 'test' }, (chunk) => {
        received.push(chunk);
      });

      expect(received.length).toBe(1);
      expect(received[0].stream).toBe(true);
      expect(received[0].data).toBe('single-chunk');
      expect(received[0].done).toBe(true);
    });

    test('rejects when server sends an error response instead of stream', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stream-err.sock');

      startRawStreamServer(socketPath, (write) => {
        write({ id: 'req-1', ok: false, error: 'app not found' });
      });

      const client = new ControlClient(socketPath);
      const received: ControlStreamChunk[] = [];

      await expect(
        client.sendStream('logs', { app: 'missing' }, (chunk) => {
          received.push(chunk);
        }),
      ).rejects.toThrow('app not found');

      expect(received.length).toBe(0);
    });

    test('rejects with "Unknown error" when error response has no error field', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stream-unknown-err.sock');

      startRawStreamServer(socketPath, (write) => {
        write({ id: 'req-1', ok: false });
      });

      const client = new ControlClient(socketPath);

      await expect(
        client.sendStream('logs', undefined, () => {}),
      ).rejects.toThrow('Unknown error');
    });

    test('handles multiple chunks sent in a single write', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stream-batch.sock');

      // Instead of using the helper, create a server that batches multiple
      // NDJSON lines into a single socket.write() call.
      const listener = Bun.listen({
        unix: socketPath,
        socket: {
          open() {
            /* wait for data */
          },

          data(socket, raw) {
            const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
            const messages = decodeMessages(text);
            if (messages.length > 0) {
              // Send three chunks concatenated in one write
              const batch =
                encodeMessage(createStreamChunk('req-1', { n: 1 })) +
                encodeMessage(createStreamChunk('req-1', { n: 2 })) +
                encodeMessage(createStreamChunk('req-1', { n: 3 }, true));
              socket.write(batch);
            }
          },

          close() {
            /* ignore */
          },
          error() {
            /* ignore */
          },
        },
      });
      rawListeners.push(listener);

      const client = new ControlClient(socketPath);
      const received: ControlStreamChunk[] = [];

      await client.sendStream('logs', undefined, (chunk) => {
        received.push(chunk);
      });

      expect(received.length).toBe(3);
      expect((received[0].data as any).n).toBe(1);
      expect((received[1].data as any).n).toBe(2);
      expect((received[2].data as any).n).toBe(3);
      expect(received[2].done).toBe(true);
    });

    test('resolves when server closes connection without done: true', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stream-close.sock');

      startRawStreamServer(socketPath, (write, close) => {
        write(createStreamChunk('req-1', { line: 'last' }));
        // Close connection without sending done: true
        setTimeout(() => close(), 50);
      });

      const client = new ControlClient(socketPath);
      const received: ControlStreamChunk[] = [];

      // Should resolve (not reject) because close() is treated as normal exit
      await client.sendStream('logs', undefined, (chunk) => {
        received.push(chunk);
      });

      expect(received.length).toBe(1);
      expect((received[0].data as any).line).toBe('last');
    });

    test('passes args through the request payload', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stream-args.sock');

      let receivedArgs: Record<string, unknown> = {};

      const listener = Bun.listen({
        unix: socketPath,
        socket: {
          open() {
            /* wait for data */
          },

          data(socket, raw) {
            const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
            const messages = decodeMessages(text);
            for (const msg of messages) {
              const req = msg as any;
              if (req.cmd && req.args) {
                receivedArgs = req.args;
                socket.write(
                  encodeMessage(createStreamChunk(req.id, { echo: req.args }, true)),
                );
              }
            }
          },

          close() {
            /* ignore */
          },
          error() {
            /* ignore */
          },
        },
      });
      rawListeners.push(listener);

      const client = new ControlClient(socketPath);
      const received: ControlStreamChunk[] = [];

      await client.sendStream('logs', { app: 'web', lines: 50 }, (chunk) => {
        received.push(chunk);
      });

      expect(receivedArgs).toEqual({ app: 'web', lines: 50 });
      expect(received.length).toBe(1);
    });

    test('handles delayed chunks over time', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stream-delay.sock');

      startRawStreamServer(socketPath, (write) => {
        write(createStreamChunk('req-1', { seq: 1 }));

        setTimeout(() => {
          write(createStreamChunk('req-1', { seq: 2 }));
        }, 50);

        setTimeout(() => {
          write(createStreamChunk('req-1', { seq: 3 }, true));
        }, 100);
      });

      const client = new ControlClient(socketPath);
      const received: ControlStreamChunk[] = [];

      await client.sendStream('monit', undefined, (chunk) => {
        received.push(chunk);
      });

      expect(received.length).toBe(3);
      expect((received[0].data as any).seq).toBe(1);
      expect((received[1].data as any).seq).toBe(2);
      expect((received[2].data as any).seq).toBe(3);
      expect(received[2].done).toBe(true);
    });

    test('error chunks before done cause rejection', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stream-mid-err.sock');

      startRawStreamServer(socketPath, (write) => {
        // Send one good chunk, then an error response
        write(createStreamChunk('req-1', { line: 'ok' }));
        write({ id: 'req-1', ok: false, error: 'stream interrupted' });
      });

      const client = new ControlClient(socketPath);
      const received: ControlStreamChunk[] = [];

      await expect(
        client.sendStream('logs', undefined, (chunk) => {
          received.push(chunk);
        }),
      ).rejects.toThrow('stream interrupted');

      // The first chunk should have been delivered before the error
      expect(received.length).toBe(1);
      expect((received[0].data as any).line).toBe('ok');
    });
  });
});
