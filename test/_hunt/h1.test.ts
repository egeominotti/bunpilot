// ---------------------------------------------------------------------------
// HUNT H1 — CL-12: "every byte accepted from one side is delivered to the
// other exactly once and in arrival order."
//
// ProxyCluster pipes bytes with bare `socket.write(...)` calls whose return
// value is discarded (src/cluster/proxy.ts:98, :233, :239) and registers no
// `drain` handler on either the public or the upstream socket. Bun's
// Socket.write() is unbuffered/non-blocking and returns SHORT when the kernel
// send buffer is full, so the un-accepted tail of every partial write is
// dropped on the floor: no error, no retry, no close.
//
// This file proves it in both directions with real TCP sockets.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import net from 'node:net';
import { ProxyCluster } from '../../src/cluster/proxy';

const TOTAL = 32 * 1024 * 1024; // 32 MiB — comfortably larger than any SO_SNDBUF
const SEED = 0xc0ffee;

/** Deterministic xorshift32 PRNG so chunk sizes are reproducible. */
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

/** Deterministic payload; byte i is a pure function of i, so any gap is visible. */
function makePayload(total: number): Buffer {
  const buf = Buffer.allocUnsafe(total);
  for (let i = 0; i < total; i++) buf[i] = (i * 31 + 7) & 0xff;
  return buf;
}

const PAYLOAD = makePayload(TOTAL);

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

/** Reserve an ephemeral port by binding then releasing it. */
function reservePort(): number {
  const probe = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = probe.port;
  probe.stop(true);
  return port;
}

/**
 * Resolve once `progress()` has stopped changing for `quietMs`, or after
 * `hardMs`. Lets the assertion observe the *final* delivered byte count even
 * when the truncated connection never closes.
 */
function settle(progress: () => number, quietMs: number, hardMs: number): Promise<void> {
  return new Promise((resolve) => {
    let last = -1;
    let lastChange = Date.now();
    const started = Date.now();
    const timer = setInterval(() => {
      const now = progress();
      if (now !== last) {
        last = now;
        lastChange = Date.now();
      }
      if (Date.now() - lastChange >= quietMs || Date.now() - started >= hardMs) {
        clearInterval(timer);
        resolve();
      }
    }, 50);
  });
}

// ---------------------------------------------------------------------------
// (a) DOWNLOAD: backend -> proxy -> slow client
// ---------------------------------------------------------------------------

test('CL-12: proxy delivers every downstream byte (backend -> client)', async () => {
  const rng = makeRng(SEED);
  let backendSent = 0;

  // Raw TCP backend that pumps TOTAL bytes, honouring its OWN backpressure
  // (it consults write()'s return value and resumes from `drain`). Whatever it
  // reports as accepted is, by definition, bytes the proxy owes the client.
  const backend = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(sock) {
        pump(sock);
      },
      drain(sock) {
        pump(sock);
      },
      error() {},
    },
  });
  cleanups.push(() => backend.stop(true));

  function pump(sock: { write(d: Buffer, off?: number, len?: number): number }): void {
    while (backendSent < TOTAL) {
      const want = Math.min(64 * 1024 + Math.floor(rng() * 64 * 1024), TOTAL - backendSent);
      const n = sock.write(PAYLOAD, backendSent, want);
      if (n <= 0) return; // full send buffer — wait for drain
      backendSent += n;
      if (n < want) return; // partial — wait for drain
    }
  }

  const publicPort = reservePort();
  const proxy = new ProxyCluster();
  proxy.start(publicPort, 1, new Map([[0, backend.port]]));
  proxy.addWorker(0, backend.port);
  cleanups.push(() => proxy.stop());

  let received = 0;
  let firstMismatchAt = -1;
  const client = net.connect(publicPort, '127.0.0.1');
  cleanups.push(() => client.destroy());

  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });

  client.on('data', (chunk: Buffer) => {
    // Verify order/integrity as well as count.
    if (firstMismatchAt === -1) {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== PAYLOAD[received + i]) {
          firstMismatchAt = received + i;
          break;
        }
      }
    }
    received += chunk.length;
  });

  client.write('GO');
  // Stall the reader so the kernel send buffer on the proxy->client socket
  // fills and Bun's write() starts returning short.
  client.pause();
  await Bun.sleep(1200);
  client.resume();

  await settle(() => received, 900, 7000);

  // The proxy accepted `backendSent` bytes from upstream; CL-12 says the client
  // must get all of them, in order.
  expect({ seed: SEED.toString(16), firstMismatchAt, received, backendSent }).toEqual({
    seed: SEED.toString(16),
    firstMismatchAt: -1,
    received: backendSent,
    backendSent,
  });
}, 25000);

// ---------------------------------------------------------------------------
// (b) UPLOAD: client -> proxy -> backend (no artificial stall at all)
// ---------------------------------------------------------------------------

test('CL-12: proxy delivers every upstream byte (client -> backend)', async () => {
  let backendGot = 0;

  const backend = Bun.listen<undefined>({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      data(_s, data) {
        backendGot += data.byteLength;
      },
      error() {},
    },
  });
  cleanups.push(() => backend.stop(true));

  const publicPort = reservePort();
  const proxy = new ProxyCluster();
  proxy.start(publicPort, 1, new Map([[0, backend.port]]));
  proxy.addWorker(0, backend.port);
  cleanups.push(() => proxy.stop());

  const client = net.connect(publicPort, '127.0.0.1');
  cleanups.push(() => client.destroy());
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('error', reject);
  });

  // node:net buffers internally, so everything handed to write() is guaranteed
  // to reach the proxy's socket. The proxy is the only lossy hop.
  let sent = 0;
  await new Promise<void>((resolve) => {
    const step = (): void => {
      while (sent < TOTAL) {
        const end = Math.min(sent + 256 * 1024, TOTAL);
        const slice = PAYLOAD.subarray(sent, end);
        sent = end;
        if (!client.write(slice)) {
          client.once('drain', step);
          return;
        }
      }
      resolve();
    };
    step();
  });

  await settle(() => backendGot, 900, 7000);

  expect({ backendGot, sent }).toEqual({ backendGot: sent, sent });
}, 25000);
