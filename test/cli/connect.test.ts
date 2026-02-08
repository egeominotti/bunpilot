// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for CLI _connect.ts Helper Functions
// ---------------------------------------------------------------------------
//
// NOTE: test/cli/commands2.test.ts uses mock.module() to replace the _connect
// module globally, which can poison the module cache when Bun runs test files
// in parallel. To handle this:
//   - Integration tests use ControlClient directly (always reliable)
//   - Tests that load _connect functions detect mock pollution and adapt
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
// Load _connect module (may be mocked by commands2.test.ts)
// ---------------------------------------------------------------------------

const CONNECT_PATH = resolve(__dirname, '../../src/cli/commands/_connect');

function loadConnect(): typeof import('../../src/cli/commands/_connect') {
  return require(CONNECT_PATH);
}

/**
 * Detect whether the _connect module is currently replaced by mock.module().
 * The mocked createClient returns a plain object without send/sendStream.
 */
function isModuleMocked(): boolean {
  const { createClient } = loadConnect();
  const client = createClient('/tmp/probe.sock');
  return typeof client.send !== 'function';
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;
const servers: ControlServer[] = [];
const rawListeners: Array<ReturnType<typeof Bun.listen>> = [];

const realProcessExit = process.exit;

function freshTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'bunpilot-connect-test-'));
  return tempDir;
}

function trackServer(server: ControlServer): ControlServer {
  servers.push(server);
  return server;
}

afterEach(() => {
  process.exit = realProcessExit;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockProcessExit(): { calls: number[]; restore: () => void } {
  const calls: number[] = [];
  process.exit = ((code?: number) => {
    calls.push(code ?? 0);
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never;
  return {
    calls,
    restore: () => {
      process.exit = realProcessExit;
    },
  };
}

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
// createClient
// ---------------------------------------------------------------------------

describe('createClient', () => {
  test('ControlClient has send and sendStream methods', () => {
    const client = new ControlClient('/tmp/test.sock');
    expect(client).toBeDefined();
    expect(typeof client.send).toBe('function');
    expect(typeof client.sendStream).toBe('function');
  });

  test('factory function returns an object', () => {
    const { createClient } = loadConnect();
    const client = createClient('/tmp/test.sock');
    expect(client).toBeDefined();
  });

  test('createClient with custom path produces client bound to that path', async () => {
    if (isModuleMocked()) return; // skip when mock.module pollutes
    const { createClient } = loadConnect();
    const dir = freshTempDir();
    const customPath = join(dir, 'custom.sock');
    const client = createClient(customPath);

    await expect(client.send('ping')).rejects.toThrow(customPath);
  });

  test('ControlClient bound to non-existent socket throws with path in message', async () => {
    const dir = freshTempDir();
    const customPath = join(dir, 'custom.sock');
    const client = new ControlClient(customPath);

    await expect(client.send('ping')).rejects.toThrow(customPath);
  });

  test('factory accepts no argument (default socket path)', () => {
    const { createClient } = loadConnect();
    const client = createClient();
    expect(client).toBeDefined();
  });

  test('factory accepts undefined as socket path', () => {
    const { createClient } = loadConnect();
    const client = createClient(undefined);
    expect(client).toBeDefined();
  });

  test('ControlClient accepts absolute paths', () => {
    const client = new ControlClient('/var/run/bunpilot/daemon.sock');
    expect(client).toBeDefined();
    expect(typeof client.send).toBe('function');
  });

  test('ControlClient accepts relative paths', () => {
    const client = new ControlClient('./local.sock');
    expect(client).toBeDefined();
    expect(typeof client.send).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// requireArg
// ---------------------------------------------------------------------------

describe('requireArg', () => {
  test('returns the first element when args is non-empty', () => {
    const { requireArg } = loadConnect();
    const result = requireArg(['my-app'], 'name');
    expect(result).toBe('my-app');
  });

  test('returns the first element even when multiple args exist', () => {
    const { requireArg } = loadConnect();
    const result = requireArg(['first', 'second', 'third'], 'name');
    expect(result).toBe('first');
  });

  test('returns numeric-string values', () => {
    const { requireArg } = loadConnect();
    const result = requireArg(['42'], 'port');
    expect(result).toBe('42');
  });

  test('returns special characters in values', () => {
    const { requireArg } = loadConnect();
    const result = requireArg(['my-app:v2.0'], 'app');
    expect(result).toBe('my-app:v2.0');
  });

  test('returns whitespace-containing values', () => {
    const { requireArg } = loadConnect();
    const result = requireArg(['my app name'], 'name');
    expect(result).toBe('my app name');
  });

  test('exits with code 1 when args array is empty', () => {
    const { requireArg } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => requireArg([], 'name')).toThrow();
      expect(exit.calls).toContain(1);
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });

  test('exits with code 1 when first element is an empty string', () => {
    const { requireArg } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => requireArg([''], 'name')).toThrow();
      expect(exit.calls).toContain(1);
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });

  test('logs error with label when argument is missing', () => {
    if (isModuleMocked()) return; // mocked requireArg uses console.error directly
    const { requireArg } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => requireArg([], 'app-name')).toThrow();

      expect(errorSpy).toHaveBeenCalled();
      const errorOutput = errorSpy.mock.calls[0][0] as string;
      expect(errorOutput).toContain('app-name');
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });

  test('error message includes "Missing required argument" and label', () => {
    if (isModuleMocked()) return;
    const { requireArg } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      expect(() => requireArg([], 'script')).toThrow();

      const errorOutput = errorSpy.mock.calls[0][0] as string;
      expect(errorOutput).toContain('Missing required argument');
      expect(errorOutput).toContain('<script>');
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });

  test('does not exit when a valid argument is provided', () => {
    const { requireArg } = loadConnect();
    const exit = mockProcessExit();

    try {
      const result = requireArg(['valid-app'], 'name');
      expect(result).toBe('valid-app');
      expect(exit.calls).toHaveLength(0);
    } finally {
      exit.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// sendCommand – error paths via ControlClient
// ---------------------------------------------------------------------------

describe('sendCommand – error paths', () => {
  test('ControlClient throws when daemon socket does not exist', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'missing.sock');
    const client = new ControlClient(socketPath);

    await expect(client.send('ping')).rejects.toThrow('daemon is not running');
  });

  test('ControlClient error message contains the socket path', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'missing.sock');
    const client = new ControlClient(socketPath);

    await expect(client.send('ping')).rejects.toThrow(socketPath);
  });

  test('sendCommand exits with code 1 on connection failure', async () => {
    if (isModuleMocked()) return;
    const { sendCommand } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(sendCommand('ping')).rejects.toThrow('process.exit');
      expect(exit.calls).toContain(1);
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });

  test('sendCommand logs daemon-not-running error', async () => {
    if (isModuleMocked()) return;
    const { sendCommand } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(sendCommand('list')).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalled();
      const errorOutput = errorSpy.mock.calls[0][0] as string;
      expect(errorOutput).toContain('daemon is not running');
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });

  test('sendCommand accepts args parameter', async () => {
    if (isModuleMocked()) return;
    const { sendCommand } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        sendCommand('stop', { name: 'my-app', force: true }),
      ).rejects.toThrow('process.exit');
      expect(exit.calls).toContain(1);
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });

  test('sendCommand accepts opts.silent parameter', async () => {
    if (isModuleMocked()) return;
    const { sendCommand } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        sendCommand('ping', undefined, { silent: true }),
      ).rejects.toThrow('process.exit');
      expect(exit.calls).toContain(1);
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// sendCommand – integration with a real ControlServer
// ---------------------------------------------------------------------------

describe('sendCommand – integration via ControlClient', () => {
  test('sends a command and receives a successful response', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'ok.sock');

    const server = trackServer(
      new ControlServer(socketPath, async (cmd) => {
        return createResponse('', { received: cmd });
      }),
    );
    await server.start();

    const client = new ControlClient(socketPath);
    const res = await client.send('ping');

    expect(res.ok).toBe(true);
    expect((res.data as any).received).toBe('ping');
  });

  test('receives an error response from the server', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'err.sock');

    const server = trackServer(
      new ControlServer(socketPath, async (cmd) => {
        return createErrorResponse('', `failed: ${cmd}`);
      }),
    );
    await server.start();

    const client = new ControlClient(socketPath);
    const res = await client.send('bad-command');

    expect(res.ok).toBe(false);
    expect(res.error).toBe('failed: bad-command');
  });

  test('passes args to the server handler', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'args.sock');

    const server = trackServer(
      new ControlServer(socketPath, async (_cmd, args) => {
        return createResponse('', { name: args.name, count: args.count });
      }),
    );
    await server.start();

    const client = new ControlClient(socketPath);
    const res = await client.send('start', { name: 'web', count: 4 });

    expect(res.ok).toBe(true);
    expect((res.data as any).name).toBe('web');
    expect((res.data as any).count).toBe(4);
  });

  test('multiple sequential sends on separate connections', async () => {
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

    const r1 = await client.send('first');
    const r2 = await client.send('second');

    expect(r1.ok).toBe(true);
    expect((r1.data as any).cmd).toBe('first');
    expect(r2.ok).toBe(true);
    expect((r2.data as any).cmd).toBe('second');
    expect((r2.data as any).call).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// sendStreamCommand – error paths
// ---------------------------------------------------------------------------

describe('sendStreamCommand – error paths', () => {
  test('ControlClient.sendStream throws when daemon socket does not exist', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'missing.sock');
    const client = new ControlClient(socketPath);

    await expect(
      client.sendStream('logs', undefined, () => {}),
    ).rejects.toThrow('daemon is not running');
  });

  test('sendStreamCommand exits with code 1 on connection failure', async () => {
    if (isModuleMocked()) return;
    const { sendStreamCommand } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const chunks: ControlStreamChunk[] = [];

    try {
      await expect(
        sendStreamCommand('logs', { name: 'app' }, (chunk: ControlStreamChunk) =>
          chunks.push(chunk),
        ),
      ).rejects.toThrow('process.exit');

      expect(exit.calls).toContain(1);
      expect(chunks).toHaveLength(0);
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });

  test('sendStreamCommand logs daemon-not-running error', async () => {
    if (isModuleMocked()) return;
    const { sendStreamCommand } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        sendStreamCommand('logs', undefined, () => {}),
      ).rejects.toThrow('process.exit');

      expect(errorSpy).toHaveBeenCalled();
      const errorOutput = errorSpy.mock.calls[0][0] as string;
      expect(errorOutput).toContain('daemon is not running');
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });

  test('sendStreamCommand accepts undefined args', async () => {
    if (isModuleMocked()) return;
    const { sendStreamCommand } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(
        sendStreamCommand('monit', undefined, () => {}),
      ).rejects.toThrow('process.exit');

      expect(exit.calls).toContain(1);
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// sendStreamCommand – integration with raw stream server
// ---------------------------------------------------------------------------

describe('sendStreamCommand – integration via ControlClient', () => {
  test('receives multiple stream chunks', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'stream.sock');

    startRawStreamServer(socketPath, (write, close) => {
      write(createStreamChunk('', { line: 'log line 1' }));
      write(createStreamChunk('', { line: 'log line 2' }));
      write({ ...createStreamChunk('', { line: 'done' }), done: true });
      close();
    });

    const client = new ControlClient(socketPath);
    const chunks: ControlStreamChunk[] = [];

    await client.sendStream('logs', { name: 'app' }, (chunk) => {
      chunks.push(chunk);
    });

    expect(chunks).toHaveLength(3);
    expect((chunks[0].data as any).line).toBe('log line 1');
    expect((chunks[1].data as any).line).toBe('log line 2');
    expect((chunks[2].data as any).line).toBe('done');
    expect(chunks[2].done).toBe(true);
  });

  test('resolves when server closes connection without done flag', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'close.sock');

    startRawStreamServer(socketPath, (write, close) => {
      write(createStreamChunk('', { line: 'only one' }));
      close();
    });

    const client = new ControlClient(socketPath);
    const chunks: ControlStreamChunk[] = [];

    await client.sendStream('logs', undefined, (chunk) => {
      chunks.push(chunk);
    });

    expect(chunks).toHaveLength(1);
    expect((chunks[0].data as any).line).toBe('only one');
  });

  test('rejects when server sends an error response instead of stream', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'err-stream.sock');

    startRawStreamServer(socketPath, (write, close) => {
      write(createErrorResponse('', 'app not found'));
      close();
    });

    const client = new ControlClient(socketPath);
    const chunks: ControlStreamChunk[] = [];

    await expect(
      client.sendStream('logs', { name: 'missing' }, (chunk) => {
        chunks.push(chunk);
      }),
    ).rejects.toThrow('app not found');

    expect(chunks).toHaveLength(0);
  });

  test('handles empty stream (server closes immediately)', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'empty.sock');

    startRawStreamServer(socketPath, (_write, close) => {
      close();
    });

    const client = new ControlClient(socketPath);
    const chunks: ControlStreamChunk[] = [];

    await client.sendStream('logs', undefined, (chunk) => {
      chunks.push(chunk);
    });

    expect(chunks).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatError – tested indirectly
// ---------------------------------------------------------------------------

describe('formatError (internal, tested indirectly)', () => {
  test('ControlClient error produces a clean message string', async () => {
    const dir = freshTempDir();
    const socketPath = join(dir, 'missing.sock');
    const client = new ControlClient(socketPath);

    try {
      await client.send('test');
      expect(true).toBe(false); // Should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      const message = (err as Error).message;
      expect(message).not.toContain('[object');
      expect(message).toContain('daemon is not running');
    }
  });

  test('sendCommand formats errors as clean strings', async () => {
    if (isModuleMocked()) return;
    const { sendCommand } = loadConnect();
    const exit = mockProcessExit();
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(sendCommand('test')).rejects.toThrow('process.exit');

      const errorOutput = errorSpy.mock.calls[0][0] as string;
      expect(errorOutput).not.toContain('[object');
      expect(errorOutput).toContain('daemon is not running');
    } finally {
      exit.restore();
      errorSpy.mockRestore();
    }
  });
});
