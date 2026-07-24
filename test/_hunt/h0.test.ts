// ---------------------------------------------------------------------------
// H0 — CTRL-06: every control-frame write must transmit the payload in full.
//
// encodeBoundedResponse explicitly permits responses up to
// MAX_CONTROL_FRAME_BYTES (1 MiB). Bun's Socket.write is a raw write that
// returns the number of bytes accepted and DROPS the remainder; ControlServer
// discards that return value and installs no drain/queue, so any response
// larger than the socket send buffer is truncated mid-JSON-line.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ControlClient } from '../../src/control/client';
import { createResponse, MAX_CONTROL_FRAME_BYTES } from '../../src/control/protocol';
import { ControlServer } from '../../src/control/server';

const tmpDirs: string[] = [];
const servers: ControlServer[] = [];

function makeSocketPath(): string {
  const dir = mkdtempSync('/private/tmp/bunpilot-h0-');
  tmpDirs.push(dir);
  return join(dir, 'control.sock');
}

afterAll(() => {
  for (const s of servers) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Deterministic 32-bit PRNG (mulberry32) so failures are reproducible. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('CTRL-06: control responses under MAX_CONTROL_FRAME_BYTES arrive intact', async () => {
  const SEED = 0x5eed_1234;
  const rng = makeRng(SEED);

  const socketPath = makeSocketPath();

  // Handler echoes back a payload of exactly the requested length.
  const server = new ControlServer(socketPath, async (_cmd, args) => {
    const size = Number(args.size);
    return createResponse('', 'x'.repeat(size));
  });
  servers.push(server);
  await server.start();

  const client = new ControlClient(socketPath);

  // Every one of these is well inside the band the server promises to serve.
  const sizes: number[] = [
    // The default `bunpilot logs api` shape: 50 access-log lines of ~170 bytes.
    50 * 170,
  ];
  for (let i = 0; i < 5; i++) {
    // Seeded sizes across 1 KiB .. 256 KiB, all < MAX_CONTROL_FRAME_BYTES.
    sizes.push(1024 + Math.floor(rng() * (256 * 1024)));
  }

  for (const size of sizes) {
    expect(size).toBeLessThan(MAX_CONTROL_FRAME_BYTES);

    let res: Awaited<ReturnType<ControlClient['send']>> | null = null;
    let failure: string | null = null;
    try {
      res = await client.send('echo', { size });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    if (failure !== null) {
      throw new Error(
        `CTRL-06 violated (seed=0x${SEED.toString(16)}, size=${size}): ` +
          `client never received a complete frame — ${failure}`,
      );
    }

    expect(res).not.toBeNull();
    const received = (res as { ok: boolean; data?: unknown }).data;
    if (typeof received !== 'string' || received.length !== size) {
      throw new Error(
        `CTRL-06 violated (seed=0x${SEED.toString(16)}, size=${size}): ` +
          `response truncated to ${typeof received === 'string' ? received.length : typeof received}`,
      );
    }
  }
}, 20_000);
