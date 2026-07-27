// ---------------------------------------------------------------------------
// bunpilot – Metrics HTTP Server
// ---------------------------------------------------------------------------

import type { Server } from 'bun';

// Bun.serve() returns a Server with a WebSocket data generic; we don't use WS.
type HttpServer = Server<undefined>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MetricsDataProvider {
  /** Return all metrics in Prometheus text exposition format. */
  getPrometheusMetrics(): string;
  /** Return metrics as a JSON-serialisable object, optionally filtered by app. */
  getJsonMetrics(appName?: string): object;
  /** Return full status of all managed applications. */
  getStatus(): object;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTENT_TYPE_JSON = 'application/json; charset=utf-8';
const CONTENT_TYPE_PROM = 'text/plain; version=0.0.4; charset=utf-8';
const CONTENT_TYPE_TEXT = 'text/plain; charset=utf-8';
/** Minimum gap between error-boundary log lines (see `MetricsHttpServer.start`). */
const ERROR_LOG_INTERVAL = 10_000;

// ---------------------------------------------------------------------------
// MetricsHttpServer
// ---------------------------------------------------------------------------

export class MetricsHttpServer {
  private readonly port: number;
  private readonly provider: MetricsDataProvider;
  private server: HttpServer | null = null;
  /** Total requests that hit the error boundary (see `start`). */
  private errorCount = 0;
  private lastErrorLogAt = 0;

  constructor(port: number, provider: MetricsDataProvider) {
    this.port = port;
    this.provider = provider;
  }

  /** Start the HTTP server using Bun.serve(). */
  start(): void {
    if (this.server) {
      return;
    }

    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: this.port,
      // Without an explicit boundary Bun renders its development error page —
      // source excerpt and stack trace — on the unauthenticated metrics port,
      // and dumps the same trace into the daemon log.
      development: false,
      fetch: (req) => this.handleRequest(req),
      error: (err) => {
        // Log it — a boundary that neither logs nor counts turns a broken
        // provider into an invisible failure — but throttled: this port is
        // unauthenticated, so an input that reliably throws would otherwise be
        // an unbounded daemon-log amplifier.
        this.errorCount++;
        const now = Date.now();
        if (now - this.lastErrorLogAt >= ERROR_LOG_INTERVAL) {
          console.error(`[metrics] request failed (${this.errorCount} total):`, err);
          this.lastErrorLogAt = now;
        }
        return new Response('Internal Server Error', {
          status: 500,
          headers: { 'Content-Type': CONTENT_TYPE_TEXT },
        });
      },
    });
  }

  /** Stop the running server. */
  stop(): void {
    if (!this.server) {
      return;
    }

    this.server.stop(true);
    this.server = null;
  }

  // -----------------------------------------------------------------------
  // Request handling
  // -----------------------------------------------------------------------

  private handleRequest(req: Request): Response {
    if (req.method !== 'GET') {
      return MetricsHttpServer.methodNotAllowed();
    }

    // `req.url` is only absolute when the client sent a Host header: an HTTP/1.0
    // request without one (legal) yields a bare path, and a malformed authority
    // (`Host: h:99999999`) yields an unparseable URL. Resolve against a base so
    // the former is a normal scrape, and reject the latter with a 400 rather
    // than letting the TypeError escape.
    let url: URL;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return new Response('Bad Request: malformed request URL', {
        status: 400,
        headers: { 'Content-Type': CONTENT_TYPE_TEXT },
      });
    }
    const path = url.pathname;

    switch (true) {
      case path === '/metrics':
        return this.handlePrometheus();

      case path === '/api/metrics':
        return this.handleJsonMetrics();

      case path.startsWith('/api/metrics/'):
        return this.handleJsonMetricsForApp(path);

      case path === '/api/status':
        return this.handleStatus();

      default:
        return MetricsHttpServer.notFound();
    }
  }

  // -----------------------------------------------------------------------
  // Route handlers
  // -----------------------------------------------------------------------

  private handlePrometheus(): Response {
    const body = this.provider.getPrometheusMetrics();
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': CONTENT_TYPE_PROM },
    });
  }

  private handleJsonMetrics(): Response {
    const data = this.provider.getJsonMetrics();
    return MetricsHttpServer.json(data);
  }

  private handleJsonMetricsForApp(path: string): Response {
    // Extract app name from "/api/metrics/<appName>"
    let appName: string;
    try {
      appName = decodeURIComponent(path.slice('/api/metrics/'.length));
    } catch {
      return new Response('Bad Request: malformed percent-encoding', {
        status: 400,
        headers: { 'Content-Type': CONTENT_TYPE_TEXT },
      });
    }
    if (!appName) {
      return MetricsHttpServer.notFound();
    }

    const data = this.provider.getJsonMetrics(appName);
    return MetricsHttpServer.json(data);
  }

  private handleStatus(): Response {
    const data = this.provider.getStatus();
    return MetricsHttpServer.json(data);
  }

  // -----------------------------------------------------------------------
  // Response helpers
  // -----------------------------------------------------------------------

  private static json(data: object, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': CONTENT_TYPE_JSON },
    });
  }

  private static notFound(): Response {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': CONTENT_TYPE_TEXT },
    });
  }

  private static methodNotAllowed(): Response {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { 'Content-Type': CONTENT_TYPE_TEXT },
    });
  }
}
