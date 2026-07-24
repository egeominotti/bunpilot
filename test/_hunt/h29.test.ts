// ---------------------------------------------------------------------------
// h29 – CTRL-06 (request side): a ControlRequest larger than the socket send
// buffer must reach the daemon in full.
//
// `ControlClient.send` does a single `s.write(payload)` in the socket `open`
// handler and discards the returned byte count (src/control/client.ts:104).
// Bun sockets do not buffer: a short write means the tail of the frame is
// silently dropped, so the daemon's NdjsonFramer never sees a newline, never
// decodes a frame, and never dispatches a handler. The client then times out
// after 5s on a command the daemon never saw.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ControlClient } from '../../src/control/client';
import { createResponse } from '../../src/control/protocol';
import { ControlServer } from '../../src/control/server';

const tempDirs: string[] = [];
const servers: ControlServer[] = [];

afterAll(() => {
  for (const server of servers) {
    try {
      server.stop();
    } catch {
      /* already stopped */
    }
  }
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeSocketPath(): string {
  const dir = mkdtempSync(join('/private/tmp', 'bp-h29-'));
  tempDirs.push(dir);
  return join(dir, 'ctl.sock');
}

/** Deterministic 32-bit PRNG (mulberry32) so payloads are reproducible. */
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

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789_';

function randomWord(rng: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return out;
}

/** Build a realistic AppConfig-shaped payload with `varCount` env entries. */
function buildConfig(rng: () => number, varCount: number): Record<string, unknown> {
  const env: Record<string, string> = {};
  for (let i = 0; i < varCount; i++) {
    env[`VAR_${i}_${randomWord(rng, 6)}`] = randomWord(rng, 20);
  }
  return { name: 'big-app', script: 'app.ts', env };
}

test('CTRL-06: a request larger than the socket send buffer reaches the daemon in full', async () => {
  const socketPath = makeSocketPath();

  const seen: Array<{ cmd: string; envCount: number; bytes: number }> = [];
  const server = new ControlServer(socketPath, async (cmd, args) => {
    const config = (args as { config?: { env?: Record<string, string> } }).config ?? {};
    const envCount = Object.keys(config.env ?? {}).length;
    const bytes = JSON.stringify(args).length;
    seen.push({ cmd, envCount, bytes });
    return createResponse('', { envCount, bytes });
  });
  servers.push(server);
  await server.start();

  const client = new ControlClient(socketPath);

  // Sweep sizes across the typical unix-socket send-buffer boundary (8 KiB).
  // Small frames must keep working; large ones are where the invariant breaks.
  const cases = [
    { seed: 0x1234, varCount: 5 },
    { seed: 0x2345, varCount: 50 },
    { seed: 0x3456, varCount: 400 },
    { seed: 0x4567, varCount: 2000 },
  ];

  for (const { seed, varCount } of cases) {
    const rng = makeRng(seed);
    const config = buildConfig(rng, varCount);
    const args = { name: 'big-app', config };
    const requestBytes = JSON.stringify(args).length;

    let response: Awaited<ReturnType<ControlClient['send']>>;
    try {
      response = await client.send('start', args);
    } catch (error) {
      throw new Error(
        `seed=0x${seed.toString(16)} varCount=${varCount} requestBytes=${requestBytes}: ` +
          `send() rejected instead of delivering the frame: ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }

    expect(response.ok).toBe(true);
    const data = response.data as { envCount: number; bytes: number };
    // The daemon must have received the WHOLE request, not a truncated prefix.
    expect(data.envCount).toBe(varCount);
    expect(data.bytes).toBe(requestBytes);
  }

  expect(seen.length).toBe(cases.length);
}, 25_000);
