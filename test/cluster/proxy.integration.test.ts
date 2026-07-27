// ---------------------------------------------------------------------------
// bunpilot – ProxyCluster TCP data-plane integration tests (H7)
// ---------------------------------------------------------------------------
//
// proxy.test.ts covers the round-robin *logic* with fake sockets. This file
// drives the real data plane: a live Bun.listen proxy forwarding to real
// Bun.serve backends on the internal ports. It is the only automated coverage
// of the path that IS macOS clustering — round-robin over TCP, bidirectional
// piping, upstream-connect-failure cleanup, and the H5 early-close teardown.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { ProxyCluster } from '../../src/cluster/proxy';
import { INTERNAL_PORT_BASE } from '../../src/constants';

const servers: Server<unknown>[] = [];
const proxies: ProxyCluster[] = [];

/** Start a backend on the internal port for `workerId` returning `body`. */
function startBackend(
  workerId: number,
  handler: (req: Request) => Response | Promise<Response>,
): void {
  const srv = Bun.serve({ port: INTERNAL_PORT_BASE + workerId, fetch: handler });
  servers.push(srv);
}

function startProxy(publicPort: number, workerCount: number): ProxyCluster {
  const proxy = new ProxyCluster();
  proxy.start(publicPort, workerCount);
  proxies.push(proxy);
  return proxy;
}

/** Pick a high public port unlikely to collide. */
function publicPort(seed: number): number {
  return 17_000 + seed;
}

/** fetch forcing a fresh TCP connection so round-robin advances per request. */
async function getOnce(port: number, path = '/'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { connection: 'close' },
  });
}

afterEach(() => {
  for (const p of proxies) p.stop();
  proxies.length = 0;
  for (const s of servers) s.stop(true);
  servers.length = 0;
});

describe('ProxyCluster integration (real sockets)', () => {
  test('round-robins TCP connections across two live backends', async () => {
    startBackend(0, () => new Response('w0'));
    startBackend(1, () => new Response('w1'));

    const port = publicPort(1);
    const proxy = startProxy(port, 2);
    proxy.addWorker(0);
    proxy.addWorker(1);

    const seen = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const res = await getOnce(port);
      seen.add(await res.text());
    }

    expect(seen.has('w0')).toBe(true);
    expect(seen.has('w1')).toBe(true);
  });

  test('pipes request bodies upstream and responses back (bidirectional)', async () => {
    startBackend(0, async (req) => new Response(`echo:${await req.text()}`));

    const port = publicPort(2);
    const proxy = startProxy(port, 1);
    proxy.addWorker(0);

    const res = await fetch(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      body: 'hello-proxy',
      headers: { connection: 'close' },
    });
    expect(await res.text()).toBe('echo:hello-proxy');
  });

  test('closes the client connection when no worker is alive', async () => {
    const port = publicPort(3);
    startProxy(port, 1); // slots exist but none marked alive

    // The proxy ends the socket with no response -> fetch fails.
    await expect(getOnce(port)).rejects.toBeDefined();
  });

  test('cleans up when the upstream connection fails (no backend listening)', async () => {
    const port = publicPort(4);
    const proxy = startProxy(port, 1);
    // Mark worker alive but never start a backend on its internal port.
    proxy.addWorker(0);

    await expect(getOnce(port)).rejects.toBeDefined();

    // Proxy must remain usable afterwards — bring up the backend and retry.
    startBackend(0, () => new Response('recovered'));
    // Give the listener a beat; then a fresh connection should succeed.
    const res = await getOnce(port);
    expect(await res.text()).toBe('recovered');
  });

  test('survives a client that closes immediately (H5 early-close)', async () => {
    startBackend(0, () => new Response('w0'));

    const port = publicPort(5);
    const proxy = startProxy(port, 1);
    proxy.addWorker(0);

    // Open a raw TCP connection and close it right away — racing the async
    // upstream connect. This must not leak/crash the proxy.
    await new Promise<void>((resolve) => {
      Bun.connect({
        hostname: '127.0.0.1',
        port,
        socket: {
          open(s) {
            s.end();
            resolve();
          },
          data() {},
          close() {},
          error() {
            resolve();
          },
        },
      }).catch(() => resolve());
    });

    // Let any deferred upstream open/teardown settle.
    await new Promise((r) => setTimeout(r, 50));

    // The proxy still serves subsequent requests normally.
    const res = await getOnce(port);
    expect(await res.text()).toBe('w0');
  });
});
