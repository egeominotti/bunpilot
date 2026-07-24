// H10 — CL-12: every byte accepted from one side must be delivered to the other
// exactly once and in arrival order.
//
// Bun's `Socket.write()` writes only what the kernel accepts right now and does
// NOT buffer the remainder — the caller must retain the tail and re-send from a
// `drain` handler. ProxyCluster ignores the return value at every write site
// (proxy.ts:98 client->upstream, :233 pre-connect flush, :239 upstream->client)
// and registers no `drain` handler, so any short write silently vanishes.
//
// This test drives the REAL ProxyCluster: a raw Bun.listen backend (standing in
// for a worker) pushes a fixed payload while honouring its own backpressure, and
// a node:net client stalls long enough to make the proxy's write to the client
// go short.

import { afterAll, expect, test } from 'bun:test';
import net from 'node:net';
import { ProxyCluster } from '../../src/cluster/proxy';

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

/** Deterministic PRNG so a failing case is reproducible from the printed seed. */
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

interface Outcome {
  accepted: number;
  received: number;
}

interface MiniSocket {
  write(b: Buffer): number;
  end(): void;
}

/**
 * Backend pushes exactly `total` bytes, counting only what the kernel accepted
 * and resuming from its own `drain` handler (so `accepted` is the exact number
 * of bytes the proxy's upstream socket was handed).  Returns that count against
 * the number of bytes the public client actually received.
 */
async function runOnce(total: number, pauseMs: number, rnd: () => number): Promise<Outcome> {
  const CHUNK = 64 * 1024;
  const filler = Buffer.alloc(CHUNK, 0x61);

  let accepted = 0;
  let ended = false;

  const pump = (sock: MiniSocket): void => {
    while (accepted < total) {
      const remaining = total - accepted;
      const buf = remaining >= CHUNK ? filler : filler.subarray(0, remaining);
      const n = sock.write(buf);
      if (n <= 0) return; // kernel buffer full — wait for drain
      accepted += n;
      if (n < buf.byteLength) return; // short write — wait for drain
    }
    if (!ended) {
      ended = true;
      sock.end();
    }
  };

  const backend = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open: (sock) => pump(sock as unknown as MiniSocket),
      drain: (sock) => pump(sock as unknown as MiniSocket),
      data: () => {},
      close: () => {},
      error: () => {},
    },
  });
  cleanups.push(() => backend.stop(true));

  // Public port: ephemeral high port, retried on collision.
  const proxy = new ProxyCluster();
  let publicPort = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    const candidate = 20000 + Math.floor(rnd() * 20000);
    try {
      proxy.start(candidate, 1, new Map([[0, backend.port]]));
      publicPort = candidate;
      break;
    } catch {
      /* port in use — try another */
    }
  }
  expect(publicPort).toBeGreaterThan(0);
  cleanups.push(() => proxy.stop());
  proxy.addWorker(0, backend.port);

  try {
    const received = await new Promise<number>((resolve, reject) => {
      let got = 0;
      let settled = false;
      const done = (n: number): void => {
        if (!settled) {
          settled = true;
          resolve(n);
        }
      };
      const client = net.connect({ host: '127.0.0.1', port: publicPort });
      const timer = setTimeout(() => {
        client.destroy();
        if (!settled) {
          settled = true;
          reject(new Error('timed out waiting for the proxied stream to close'));
        }
      }, 12000);
      timer.unref?.();

      client.on('connect', () => {
        // Stall: stop reading so the proxy's write() to us must go short.
        client.pause();
        setTimeout(() => client.resume(), pauseMs);
      });
      client.on('data', (c: Buffer) => {
        got += c.byteLength;
      });
      client.on('end', () => {
        clearTimeout(timer);
        client.destroy();
        done(got);
      });
      client.on('close', () => {
        clearTimeout(timer);
        done(got);
      });
      client.on('error', (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });

    return { accepted, received };
  } finally {
    proxy.stop();
    backend.stop(true);
  }
}

test('CL-12: proxy delivers every byte the upstream handed it, even under client backpressure', async () => {
  const cases: Array<{ seed: number; total: number; pauseMs: number }> = [
    { seed: 0x51ee7, total: 32 * 1024 * 1024, pauseMs: 400 },
    { seed: 0xbeef1, total: 24 * 1024 * 1024, pauseMs: 250 },
  ];

  for (const c of cases) {
    const rnd = mulberry32(c.seed);
    const { accepted, received } = await runOnce(c.total, c.pauseMs, rnd);

    if (received !== accepted) {
      console.error(
        `CL-12 VIOLATED seed=0x${c.seed.toString(16)} total=${c.total} pauseMs=${c.pauseMs}: ` +
          `upstream handed the proxy ${accepted} bytes, client received ${received} ` +
          `(${accepted - received} bytes silently dropped)`,
      );
    }

    // Sanity: the backend really did push the whole payload into the proxy.
    expect(accepted).toBe(c.total);
    // CL-12: nothing may be lost between the two sides.
    expect(received).toBe(accepted);
  }
}, 25000);
