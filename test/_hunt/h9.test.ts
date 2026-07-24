// ---------------------------------------------------------------------------
// H9 – ProxyCluster must not silently drop bytes on partial socket writes.
// ---------------------------------------------------------------------------
//
// Bun's TCPSocket.write() is NOT internally buffered: it returns the number of
// bytes the kernel accepted and DISCARDS the rest. ProxyCluster ignores that
// return value at all three write sites (upstream->client, client->upstream,
// pre-connect flush) and never pauses the reading side, so once the peer's
// send buffer fills the proxy loses data with no error and no log.
//
// Invariant: every byte accepted from one side is delivered to the other
// exactly once, in arrival order.
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import type { TCPSocketListener } from 'bun';
import { ProxyCluster } from '../../src/cluster/proxy';

const listeners: TCPSocketListener<unknown>[] = [];
const proxies: ProxyCluster[] = [];

afterEach(() => {
  for (const p of proxies) p.stop();
  proxies.length = 0;
  for (const l of listeners) {
    try {
      l.stop(true);
    } catch {
      /* already stopped */
    }
  }
  listeners.length = 0;
});

/** Deterministic xorshift32 PRNG so payload content is reproducible. */
function makePayload(seed: number, size: number): Buffer {
  let s = seed >>> 0 || 0x9e3779b9;
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    buf[i] = s & 0xff;
  }
  return buf;
}

/** Grab a port that is free right now. */
function freePort(): number {
  const probe = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: { data() {}, open() {}, close() {}, error() {} },
  });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/** Block the event loop so the peer's socket buffers fill up. */
function stall(ms: number): void {
  const until = Bun.nanoseconds() + ms * 1_000_000;
  while (Bun.nanoseconds() < until) {
    /* spin – deliberate: this is what a slow consumer looks like */
  }
}

const SEED = 0xb00b1e5;
const TOTAL = 24 * 1024 * 1024;
const CHUNK = 256 * 1024;

test('proxy forwards a large upstream response to a slow client byte-for-byte', async () => {
  const payload = makePayload(SEED, TOTAL);

  // --- fake worker: drain-aware writer, only advances by bytes accepted ----
  let workerSent = 0;
  const worker = Bun.listen<{ off: number }>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(sock) {
        sock.data = { off: 0 };
        pump(sock);
      },
      drain(sock) {
        pump(sock);
      },
      data() {},
      close() {},
      error() {},
    },
  });
  listeners.push(worker as unknown as TCPSocketListener<unknown>);

  function pump(sock: { data: { off: number }; write(b: Buffer): number; end(): void }): void {
    while (sock.data.off < TOTAL) {
      const start = sock.data.off;
      const end = Math.min(start + CHUNK, TOTAL);
      const want = end - start;
      const n = sock.write(payload.subarray(start, end));
      if (n <= 0) return; // buffer full – resume from drain()
      sock.data.off = start + n;
      workerSent = sock.data.off;
      if (n < want) return; // short write – resume from drain()
    }
    sock.end();
  }

  // --- proxy in front of the worker ---------------------------------------
  const publicPort = freePort();
  const proxy = new ProxyCluster();
  proxies.push(proxy);
  proxy.start(publicPort, 1, new Map([[0, worker.port]]));
  proxy.addWorker(0, worker.port);

  // --- slow client ---------------------------------------------------------
  let received = 0;
  let firstMismatch = -1;

  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 15_000);
    Bun.connect({
      hostname: '127.0.0.1',
      port: publicPort,
      socket: {
        open() {
          /* nothing to send – the worker pushes immediately */
        },
        data(_s, d) {
          const chunk = Buffer.from(d.buffer, d.byteOffset, d.byteLength);
          if (firstMismatch < 0 && received + chunk.byteLength <= TOTAL) {
            const expected = payload.subarray(received, received + chunk.byteLength);
            if (Buffer.compare(chunk, expected) !== 0) firstMismatch = received;
          }
          received += chunk.byteLength;
          stall(4);
        },
        close() {
          clearTimeout(timer);
          resolve();
        },
        error() {
          clearTimeout(timer);
          resolve();
        },
      },
    }).catch(() => {
      clearTimeout(timer);
      resolve();
    });
  });

  // The worker itself must have handed every byte to the proxy.
  expect(workerSent).toBe(TOTAL);
  // Nothing may be silently dropped in between.
  expect(received).toBe(TOTAL);
  // …and order/content of what arrived must be intact (no gaps).
  expect(firstMismatch).toBe(-1);
}, 25_000);
