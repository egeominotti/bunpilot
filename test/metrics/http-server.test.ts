// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for MetricsHttpServer
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { MetricsHttpServer, type MetricsDataProvider } from '../../src/metrics/http-server';

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
