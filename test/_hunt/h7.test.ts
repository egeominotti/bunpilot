// ---------------------------------------------------------------------------
// h7 – CTRL-06: every socket.write() of a control frame must transmit in full.
//
// Bun's Socket.write() returns the number of bytes the kernel accepted and does
// NOT buffer the remainder. On a unix SOCK_STREAM the send buffer is 8 KiB, so
// any control frame larger than that is silently truncated unless the writer
// re-writes the tail on `drain`. src/control/server.ts (141/152/161) and
// src/control/client.ts (104/190) all discard the return value and register no
// `drain` handler.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ControlResponse } from '../../src/config/types';
import { ControlClient } from '../../src/control/client';
import { createResponse, encodeMessage, NdjsonFramer } from '../../src/control/protocol';
import { ControlServer } from '../../src/control/server';
import { makeTempDir } from '../_helpers/tmp';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const roots: string[] = [];
const servers: ControlServer[] = [];
const openSockets: { end(): void }[] = [];

function freshDir(): string {
  const dir = makeTempDir('bunpilot-h7-');
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const s of openSockets) {
    try {
      s.end();
    } catch {
      /* already closed */
    }
  }
  for (const srv of servers) {
    try {
      srv.stop();
    } catch {
      /* already stopped */
    }
  }
  for (const dir of roots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  // Guard against an accidental default-path server.
  expect(tmpdir().length).toBeGreaterThan(0);
});

function track(srv: ControlServer): ControlServer {
  servers.push(srv);
  return srv;
}

/** Deterministic PRNG so a failure reports a reproducible seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface RawResult {
  msg: ControlResponse | null;
  bytesReceived: number;
}

/**
 * Raw NDJSON client: writes an already-encoded request and waits for the
 * response frame with the matching id, or gives up after `deadlineMs`.
 * Deliberately does not use ControlClient so the response direction can be
 * probed without paying its 5 s timeout on every iteration.
 */
function rawSend(socketPath: string, req: object, deadlineMs: number): Promise<RawResult> {
  const payload = encodeMessage(req);
  const id = (req as { id: string }).id;

  return new Promise<RawResult>((resolve) => {
    const framer = new NdjsonFramer();
    let bytesReceived = 0;
    let settled = false;
    let sock: { end(): void } | null = null;

    const finish = (msg: ControlResponse | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock?.end();
      } catch {
        /* already closed */
      }
      resolve({ msg, bytesReceived });
    };

    const timer = setTimeout(() => finish(null), deadlineMs);

    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          sock = s;
          openSockets.push(s);
          s.write(payload);
        },
        data(_s, raw) {
          bytesReceived += raw.byteLength;
          let msgs: object[];
          try {
            msgs = framer.push(raw);
          } catch {
            finish(null);
            return;
          }
          for (const m of msgs) {
            if ('ok' in m && (m as ControlResponse).id === id) {
              finish(m as ControlResponse);
              return;
            }
          }
        },
        close() {
          finish(null);
        },
        error() {
          finish(null);
        },
      },
    }).catch(() => finish(null));
  });
}

// ---------------------------------------------------------------------------
// (a) RESPONSE direction – server.ts:152
// ---------------------------------------------------------------------------

test('CTRL-06: server transmits every response frame in full (property, seeded)', async () => {
  const socketPath = join(freshDir(), 'resp.sock');
  const server = track(
    new ControlServer(socketPath, async (_cmd, args) => {
      const n = Number(args.n);
      return createResponse('', 'y'.repeat(n));
    }),
  );
  await server.start();

  const SEED = 0x00c7_1206;
  const rnd = mulberry32(SEED);

  for (let i = 0; i < 24; i++) {
    // Sizes straddle the 8 KiB unix sndbuf: many are small (must already pass),
    // some are large (must also pass — MAX_CONTROL_FRAME_BYTES is 1 MiB).
    // First 4 iterations stay well under the 8 KiB sndbuf: they must pass on
    // today's code too, proving the harness itself is sound.
    const n = i < 4 ? 128 + Math.floor(rnd() * 3_000) : 128 + Math.floor(rnd() * 40_000);
    const id = `h7-resp-${i}`;
    const { msg, bytesReceived } = await rawSend(socketPath, { id, cmd: 'dump', args: { n } }, 900);

    const detail = `seed=0x${SEED.toString(16)} iter=${i} payloadBytes=${n} bytesReceived=${bytesReceived}`;
    expect(msg, `no complete response frame for ${detail}`).not.toBeNull();
    expect((msg as ControlResponse).ok, `error response for ${detail}`).toBe(true);
    expect((msg as ControlResponse).data as string, `truncated data for ${detail}`).toHaveLength(n);
  }
}, 30_000);

// ---------------------------------------------------------------------------
// (b) REQUEST direction – client.ts:104
// ---------------------------------------------------------------------------

test('CTRL-06: client transmits every request frame in full (property, seeded)', async () => {
  const socketPath = join(freshDir(), 'req.sock');
  const server = track(
    new ControlServer(socketPath, async (_cmd, args) =>
      createResponse('', { len: typeof args.pad === 'string' ? args.pad.length : -1 }),
    ),
  );
  await server.start();

  const SEED = 0x0000_beef;
  const rnd = mulberry32(SEED);

  // This direction must go through the real ControlClient: a hand-rolled raw
  // writer would only be testing the harness, not src/control/client.ts.
  const client = new ControlClient(socketPath);

  for (let i = 0; i < 6; i++) {
    // First 4 iterations stay well under the 8 KiB sndbuf: they must pass on
    // today's code too, proving the harness itself is sound.
    const n = i < 4 ? 128 + Math.floor(rnd() * 3_000) : 128 + Math.floor(rnd() * 40_000);
    const detail = `seed=0x${SEED.toString(16)} iter=${i} requestPadBytes=${n}`;

    let res: ControlResponse;
    try {
      res = await client.send('ping', { pad: 'z'.repeat(n) });
    } catch (error) {
      throw new Error(
        `request frame never fully reached the daemon for ${detail}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    expect(res.data as { len: number }, `wrong pad length for ${detail}`).toEqual({ len: n });
  }
}, 30_000);

// ---------------------------------------------------------------------------
// (c) End-to-end through the real ControlClient (the operator-visible symptom)
// ---------------------------------------------------------------------------

test('CTRL-06: ControlClient.send resolves a 32 KiB response instead of timing out', async () => {
  const socketPath = join(freshDir(), 'e2e.sock');
  const server = track(
    new ControlServer(socketPath, async () => createResponse('', 'y'.repeat(32 * 1024))),
  );
  await server.start();

  const res = await new ControlClient(socketPath).send('dump');
  expect(res.ok).toBe(true);
  expect((res.data as string).length).toBe(32 * 1024);
}, 30_000);
