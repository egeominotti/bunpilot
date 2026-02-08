// ---------------------------------------------------------------------------
// bunpilot – Control Server unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { ControlServer, type CommandHandler } from '../../src/control/server';
import { createResponse, createErrorResponse } from '../../src/control/protocol';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;
const servers: ControlServer[] = [];

function freshTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'bunpilot-server-test-'));
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

  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function echoHandler(): CommandHandler {
  return async (cmd, args) => {
    return createResponse('', { cmd, args });
  };
}

function trackServer(server: ControlServer): ControlServer {
  servers.push(server);
  return server;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

describe('ControlServer', () => {
  describe('constructor', () => {
    test('creates an instance without starting', () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'test.sock');
      const server = trackServer(new ControlServer(socketPath, echoHandler()));
      expect(server).toBeDefined();
      expect(existsSync(socketPath)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  describe('start()', () => {
    test('creates the socket file', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'test.sock');
      const server = trackServer(new ControlServer(socketPath, echoHandler()));

      await server.start();
      expect(existsSync(socketPath)).toBe(true);
    });

    test('removes stale socket before starting', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'stale.sock');

      // Create a stale file at the socket path
      writeFileSync(socketPath, 'stale');
      expect(existsSync(socketPath)).toBe(true);

      const server = trackServer(new ControlServer(socketPath, echoHandler()));
      await server.start();
      // Socket should exist (replaced stale file)
      expect(existsSync(socketPath)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // stop()
  // -------------------------------------------------------------------------

  describe('stop()', () => {
    test('cleans up socket file', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'cleanup.sock');
      const server = trackServer(new ControlServer(socketPath, echoHandler()));

      await server.start();
      expect(existsSync(socketPath)).toBe(true);

      server.stop();
      expect(existsSync(socketPath)).toBe(false);
    });

    test('does not throw when called multiple times', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'multi-stop.sock');
      const server = trackServer(new ControlServer(socketPath, echoHandler()));

      await server.start();
      server.stop();
      expect(() => server.stop()).not.toThrow();
    });

    test('does not throw when called without start', () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'no-start.sock');
      const server = trackServer(new ControlServer(socketPath, echoHandler()));

      expect(() => server.stop()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Request handling
  // -------------------------------------------------------------------------

  describe('request handling', () => {
    test('responds to a valid NDJSON request', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'req.sock');
      const server = trackServer(
        new ControlServer(socketPath, async (cmd, args) => {
          return createResponse('', { echo: cmd });
        }),
      );

      await server.start();

      // Connect as a raw client and send a valid request
      const response = await new Promise<string>((resolve, reject) => {
        let buf = '';
        Bun.connect({
          unix: socketPath,
          socket: {
            open(s) {
              s.write(JSON.stringify({ id: 'test-1', cmd: 'ping', args: {} }) + '\n');
            },
            data(_s, raw) {
              buf += typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
              if (buf.includes('\n')) {
                resolve(buf.trim());
              }
            },
            close() {
              reject(new Error('Connection closed'));
            },
            error(_s, err) {
              reject(err);
            },
          },
        }).catch(reject);
      });

      const parsed = JSON.parse(response);
      expect(parsed.ok).toBe(true);
      expect(parsed.id).toBe('test-1');
      expect(parsed.data).toEqual({ echo: 'ping' });
    });

    test('returns error for request missing id', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'bad-req.sock');
      const server = trackServer(new ControlServer(socketPath, echoHandler()));

      await server.start();

      const response = await new Promise<string>((resolve, reject) => {
        let buf = '';
        Bun.connect({
          unix: socketPath,
          socket: {
            open(s) {
              // Send request without id
              s.write(JSON.stringify({ cmd: 'ping', args: {} }) + '\n');
            },
            data(_s, raw) {
              buf += typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
              if (buf.includes('\n')) {
                resolve(buf.trim());
              }
            },
            close() {
              reject(new Error('Connection closed'));
            },
            error(_s, err) {
              reject(err);
            },
          },
        }).catch(reject);
      });

      const parsed = JSON.parse(response);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('Invalid request');
    });

    test('returns error for request missing cmd', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'no-cmd.sock');
      const server = trackServer(new ControlServer(socketPath, echoHandler()));

      await server.start();

      const response = await new Promise<string>((resolve, reject) => {
        let buf = '';
        Bun.connect({
          unix: socketPath,
          socket: {
            open(s) {
              s.write(JSON.stringify({ id: 'test-2', args: {} }) + '\n');
            },
            data(_s, raw) {
              buf += typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
              if (buf.includes('\n')) {
                resolve(buf.trim());
              }
            },
            close() {
              reject(new Error('Connection closed'));
            },
            error(_s, err) {
              reject(err);
            },
          },
        }).catch(reject);
      });

      const parsed = JSON.parse(response);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toContain('Invalid request');
    });

    test('handler error is returned as error response', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'handler-err.sock');
      const server = trackServer(
        new ControlServer(socketPath, async () => {
          throw new Error('handler exploded');
        }),
      );

      await server.start();

      const response = await new Promise<string>((resolve, reject) => {
        let buf = '';
        Bun.connect({
          unix: socketPath,
          socket: {
            open(s) {
              s.write(JSON.stringify({ id: 'err-1', cmd: 'boom', args: {} }) + '\n');
            },
            data(_s, raw) {
              buf += typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
              if (buf.includes('\n')) {
                resolve(buf.trim());
              }
            },
            close() {
              reject(new Error('Connection closed'));
            },
            error(_s, err) {
              reject(err);
            },
          },
        }).catch(reject);
      });

      const parsed = JSON.parse(response);
      expect(parsed.ok).toBe(false);
      expect(parsed.error).toBe('handler exploded');
    });

    test('handles multiple concurrent clients', async () => {
      const dir = freshTempDir();
      const socketPath = join(dir, 'multi.sock');
      const server = trackServer(
        new ControlServer(socketPath, async (cmd, args) => {
          return createResponse('', { cmd, name: args.name });
        }),
      );

      await server.start();

      const sendRequest = (id: string, name: string): Promise<object> =>
        new Promise((resolve, reject) => {
          let buf = '';
          Bun.connect({
            unix: socketPath,
            socket: {
              open(s) {
                s.write(JSON.stringify({ id, cmd: 'status', args: { name } }) + '\n');
              },
              data(_s, raw) {
                buf += typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
                if (buf.includes('\n')) {
                  resolve(JSON.parse(buf.trim()));
                }
              },
              close() {
                reject(new Error('Connection closed'));
              },
              error(_s, err) {
                reject(err);
              },
            },
          }).catch(reject);
        });

      const [r1, r2, r3] = await Promise.all([
        sendRequest('c1', 'web'),
        sendRequest('c2', 'api'),
        sendRequest('c3', 'worker'),
      ]);

      expect((r1 as any).id).toBe('c1');
      expect((r1 as any).data.name).toBe('web');
      expect((r2 as any).id).toBe('c2');
      expect((r2 as any).data.name).toBe('api');
      expect((r3 as any).id).toBe('c3');
      expect((r3 as any).data.name).toBe('worker');
    });
  });
});
