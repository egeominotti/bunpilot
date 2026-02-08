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
import { createResponse, createErrorResponse } from '../../src/control/protocol';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tempDir: string;
const servers: ControlServer[] = [];

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

  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function trackServer(server: ControlServer): ControlServer {
  servers.push(server);
  return server;
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
});
