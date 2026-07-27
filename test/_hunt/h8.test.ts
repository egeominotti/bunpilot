import { afterAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ControlClient } from '../../src/control/client';
import { createResponse } from '../../src/control/protocol';
import { ControlServer } from '../../src/control/server';
import { makeTempDir } from '../_helpers/tmp';

// ---------------------------------------------------------------------------
// CTRL-06: every socket.write(payload) of a control frame must transmit the
// payload in full. Bun's socket.write() returns the number of bytes actually
// accepted by the kernel; on a unix socket that saturates at the send buffer
// (~8 KiB). src/control/client.ts:104/190 and src/control/server.ts:141/152/160
// discard that return value and register no `drain` handler, so any frame
// larger than the send buffer is truncated. The truncated NDJSON line never
// gets its terminating '\n', so the peer's NdjsonFramer buffers it forever and
// never dispatches -> the request/response silently hangs until the 5s timeout.
// ---------------------------------------------------------------------------

// Keep the socket path short: macOS caps sun_path at ~104 bytes.
const dir = makeTempDir('bp-h8-');
const servers: ControlServer[] = [];

afterAll(() => {
  for (const s of servers) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

async function startServer(
  name: string,
  handler: (
    cmd: string,
    args: Record<string, unknown>,
  ) => Promise<ReturnType<typeof createResponse>>,
): Promise<string> {
  const sock = join(dir, `${name}.sock`);
  // ControlServer stamps the real request id via encodeBoundedResponse, so the
  // handler may return a response with an empty id.
  const server = new ControlServer(sock, handler as never);
  await server.start();
  servers.push(server);
  return sock;
}

/** Seeded xorshift32 PRNG so failures are reproducible. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

test('CTRL-06: responses larger than the socket send buffer round-trip intact', async () => {
  const sock = await startServer('resp', async (_cmd, args) => {
    const size = Number(args.size);
    return createResponse('', { blob: 'y'.repeat(size) });
  });

  const rng = makeRng(0x5eed_8008);
  const sizes = [8000, 8192, 16384, 262144];
  for (let i = 0; i < 4; i++) sizes.push(8192 + Math.floor(rng() * 120000));

  const client = new ControlClient(sock);

  // Run concurrently: each send() opens its own connection, so the 5s client
  // timeouts overlap instead of stacking up.
  const results = await Promise.all(
    sizes.map(async (size) => {
      try {
        const res = await client.send('echo', { size });
        const blob = (res.data as { blob?: string } | undefined)?.blob;
        return { size, ok: res.ok === true, len: blob?.length ?? -1, err: '' };
      } catch (err) {
        return { size, ok: false, len: -1, err: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const broken = results.filter((r) => r.len !== r.size);
  if (broken.length > 0) {
    const detail = broken
      .map((r) => `size=${r.size} -> len=${r.len}${r.err ? ` err=${r.err}` : ''}`)
      .join('\n  ');
    throw new Error(
      `CTRL-06 violated (seed=0x5eed8008): ${broken.length}/${results.length} responses did not round-trip in full:\n  ${detail}`,
    );
  }

  for (const r of results) expect(r.len).toBe(r.size);
}, 25000);

test('CTRL-06: requests larger than the socket send buffer arrive intact', async () => {
  // Echo back the blob length the server actually observed.
  const sock = await startServer('req', async (_cmd, args) => {
    const blob = typeof args.blob === 'string' ? args.blob : '';
    return createResponse('', { len: blob.length });
  });

  const rng = makeRng(0x1234_abcd);
  const sizes = [8000, 8192, 16384, 262144];
  for (let i = 0; i < 4; i++) sizes.push(8192 + Math.floor(rng() * 120000));

  const client = new ControlClient(sock);

  const results = await Promise.all(
    sizes.map(async (size) => {
      try {
        const res = await client.send('start', { blob: 'x'.repeat(size) });
        const len = (res.data as { len?: number } | undefined)?.len ?? -1;
        return { size, len, err: '' };
      } catch (err) {
        return { size, len: -1, err: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

  const broken = results.filter((r) => r.len !== r.size);
  if (broken.length > 0) {
    const detail = broken
      .map((r) => `size=${r.size} -> serverSaw=${r.len}${r.err ? ` err=${r.err}` : ''}`)
      .join('\n  ');
    throw new Error(
      `CTRL-06 violated (seed=0x1234abcd): ${broken.length}/${results.length} requests did not arrive in full:\n  ${detail}`,
    );
  }

  for (const r of results) expect(r.len).toBe(r.size);
}, 25000);
