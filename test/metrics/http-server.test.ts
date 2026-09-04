// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for MetricsHttpServer
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, test } from 'bun:test';
import { type MetricsDataProvider, MetricsHttpServer } from '../../src/metrics/http-server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub provider that returns deterministic data. */
function makeProvider(overrides: Partial<MetricsDataProvider> = {}): MetricsDataProvider {
  return {
    getPrometheusMetrics: () => '# HELP up\nup 1\n',
    getJsonMetrics: (appName?: string) => {
      if (appName) {
        return { app: appName, cpu: 12, memory: 1024 };
      }
      return { apps: [{ name: 'web', cpu: 12, memory: 1024 }] };
    },
    getStatus: () => ({
      apps: [{ name: 'web', status: 'running', workers: 2 }],
    }),
    ...overrides,
  };
}

/** Get a random high port to avoid collisions during parallel test runs. */
function randomPort(): number {
  return 30_000 + Math.floor(Math.random() * 20_000);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetricsHttpServer', () => {
  let server: MetricsHttpServer | null = null;
  let port: number;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  // -----------------------------------------------------------------------
  // Construction
  // -----------------------------------------------------------------------

  describe('creation', () => {
    test('creates an instance', () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      expect(server).toBeInstanceOf(MetricsHttpServer);
    });
  });

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    test('start does not throw', () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      expect(() => server!.start()).not.toThrow();
    });

    test('calling start twice is idempotent', () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();
      // Second call should not throw or create a second listener
      expect(() => server!.start()).not.toThrow();
    });

    test('stop does not throw', () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();
      expect(() => server!.stop()).not.toThrow();
    });

    test('stop before start does not throw', () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      expect(() => server!.stop()).not.toThrow();
    });

    test('calling stop twice does not throw', () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();
      server.stop();
      expect(() => server!.stop()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // /metrics endpoint (Prometheus format)
  // -----------------------------------------------------------------------

  describe('GET /metrics', () => {
    test('returns prometheus text format', async () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();

      const res = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(res.status).toBe(200);

      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain('text/plain');

      const body = await res.text();
      expect(body).toContain('up 1');
    });

    test('coalesces repeated scrapes for a bounded interval', async () => {
      let now = 1_000;
      let calls = 0;
      port = randomPort();
      server = new MetricsHttpServer(
        port,
        makeProvider({ getPrometheusMetrics: () => `up ${++calls}\n` }),
        { cacheTtlMs: 250, now: () => now },
      );
      server.start();

      expect(await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text())).toBe('up 1\n');
      expect(await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text())).toBe('up 1\n');
      expect(calls).toBe(1);

      now += 250;
      expect(await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text())).toBe('up 2\n');
      expect(calls).toBe(2);
    });

    test('uses the 250 ms default TTL and expires exactly at the boundary', async () => {
      let now = 100;
      let calls = 0;
      port = randomPort();
      server = new MetricsHttpServer(
        port,
        makeProvider({ getPrometheusMetrics: () => `up ${++calls}\n` }),
        { now: () => now },
      );
      server.start();

      const read = () => fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text());
      expect(await read()).toBe('up 1\n');
      now += 249;
      expect(await read()).toBe('up 1\n');
      now += 1;
      expect(await read()).toBe('up 2\n');
    });

    test('invalid or regressing clocks invalidate instead of preserving stale data', async () => {
      let now = 1_000;
      let calls = 0;
      port = randomPort();
      server = new MetricsHttpServer(
        port,
        makeProvider({ getPrometheusMetrics: () => `up ${++calls}\n` }),
        { cacheTtlMs: 500, now: () => now },
      );
      server.start();

      const read = () => fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text());
      expect(await read()).toBe('up 1\n');
      now = 900;
      expect(await read()).toBe('up 2\n');
      now = Number.NaN;
      expect(await read()).toBe('up 3\n');
      now = Number.POSITIVE_INFINITY;
      expect(await read()).toBe('up 4\n');
    });

    test('caps oversized TTLs and handles clock values near numeric overflow', async () => {
      let now = Number.MAX_SAFE_INTEGER - 500;
      let calls = 0;
      port = randomPort();
      server = new MetricsHttpServer(
        port,
        makeProvider({ getPrometheusMetrics: () => `up ${++calls}\n` }),
        { cacheTtlMs: Number.MAX_VALUE, now: () => now },
      );
      server.start();

      const read = () => fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text());
      expect(await read()).toBe('up 1\n');
      now = Number.MAX_SAFE_INTEGER - 1;
      expect(await read()).toBe('up 1\n');
      now = Number.MAX_SAFE_INTEGER;
      expect(await read()).toBe('up 2\n');
    });

    test('does not cache provider failures', async () => {
      let calls = 0;
      port = randomPort();
      server = new MetricsHttpServer(
        port,
        makeProvider({
          getPrometheusMetrics: () => {
            if (++calls === 1) throw new Error('synthetic provider failure');
            return 'up 2\n';
          },
        }),
      );
      server.start();

      expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(500);
      expect(await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text())).toBe('up 2\n');
      expect(calls).toBe(2);
    });

    test('clears cached bodies across a stop/start cycle', async () => {
      let calls = 0;
      port = randomPort();
      server = new MetricsHttpServer(
        port,
        makeProvider({ getPrometheusMetrics: () => `up ${++calls}\n` }),
      );
      server.start();
      expect(await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text())).toBe('up 1\n');
      server.stop();
      server.start();
      expect(await fetch(`http://127.0.0.1:${port}/metrics`).then((r) => r.text())).toBe('up 2\n');
    });
  });

  // -----------------------------------------------------------------------
  // /api/metrics endpoint (JSON)
  // -----------------------------------------------------------------------

  describe('GET /api/metrics', () => {
    test('returns JSON metrics', async () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();

      const res = await fetch(`http://127.0.0.1:${port}/api/metrics`);
      expect(res.status).toBe(200);

      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain('application/json');

      const data = (await res.json()) as { apps: { name: string }[] };
      expect(data.apps).toBeDefined();
      expect(data.apps[0].name).toBe('web');
    });

    test('caches only the fleet response and expires it deterministically', async () => {
      let now = 5_000;
      let calls = 0;
      port = randomPort();
      server = new MetricsHttpServer(
        port,
        makeProvider({ getJsonMetrics: () => ({ generation: ++calls }) }),
        { cacheTtlMs: 100, now: () => now },
      );
      server.start();

      const read = async () =>
        (await fetch(`http://127.0.0.1:${port}/api/metrics`).then((r) => r.json())) as {
          generation: number;
        };
      expect((await read()).generation).toBe(1);
      expect((await read()).generation).toBe(1);
      expect(calls).toBe(1);

      now += 100;
      expect((await read()).generation).toBe(2);
      expect(calls).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // /api/metrics/:appName endpoint
  // -----------------------------------------------------------------------

  describe('GET /api/metrics/:appName', () => {
    test('returns metrics for a specific app', async () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();

      const res = await fetch(`http://127.0.0.1:${port}/api/metrics/web`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as { app: string; cpu: number };
      expect(data.app).toBe('web');
      expect(data.cpu).toBe(12);
    });
  });

  // -----------------------------------------------------------------------
  // /api/status endpoint
  // -----------------------------------------------------------------------

  describe('GET /api/status', () => {
    test('returns status data', async () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();

      const res = await fetch(`http://127.0.0.1:${port}/api/status`);
      expect(res.status).toBe(200);

      const ct = res.headers.get('content-type') ?? '';
      expect(ct).toContain('application/json');

      const data = (await res.json()) as { apps: { name: string; status: string }[] };
      expect(data.apps).toBeDefined();
      expect(data.apps[0].status).toBe('running');
    });

    test('bounds status staleness and supports disabling the cache', async () => {
      let calls = 0;
      port = randomPort();
      server = new MetricsHttpServer(
        port,
        makeProvider({ getStatus: () => ({ generation: ++calls }) }),
        { cacheTtlMs: 0, now: () => 10_000 },
      );
      server.start();

      const first = (await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json())) as {
        generation: number;
      };
      const second = (await fetch(`http://127.0.0.1:${port}/api/status`).then((r) => r.json())) as {
        generation: number;
      };
      expect(first.generation).toBe(1);
      expect(second.generation).toBe(2);
      expect(calls).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // 404 for unknown routes
  // -----------------------------------------------------------------------

  describe('unknown routes', () => {
    test('returns 404 for unmatched path', async () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();

      const res = await fetch(`http://127.0.0.1:${port}/unknown`);
      expect(res.status).toBe(404);
    });
  });

  // -----------------------------------------------------------------------
  // 400 for malformed percent-encoding (Bug 12)
  // -----------------------------------------------------------------------

  describe('malformed percent-encoding', () => {
    test('returns 400 for malformed percent-encoding in app name', async () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();

      const res = await fetch(`http://127.0.0.1:${port}/api/metrics/%ZZ`);
      expect(res.status).toBe(400);
      const body = await res.text();
      expect(body).toContain('Bad Request');
    });

    test('returns 400 for incomplete percent-encoding', async () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();

      const res = await fetch(`http://127.0.0.1:${port}/api/metrics/%E0%A4%`);
      expect(res.status).toBe(400);
    });
  });

  // -----------------------------------------------------------------------
  // 405 for non-GET methods
  // -----------------------------------------------------------------------

  describe('method not allowed', () => {
    test('returns 405 for POST', async () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();

      const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
        method: 'POST',
      });
      expect(res.status).toBe(405);
    });

    test('returns 405 for PUT', async () => {
      port = randomPort();
      server = new MetricsHttpServer(port, makeProvider());
      server.start();

      const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
        method: 'PUT',
      });
      expect(res.status).toBe(405);
    });
  });
});
