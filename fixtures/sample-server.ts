// ---------------------------------------------------------------------------
// bunpilot – Sample HTTP Server Fixture
// ---------------------------------------------------------------------------
// A basic HTTP server demonstrating bunpilot SDK integration.
// Run with: bunpilot start fixtures/sample-server.ts
// ---------------------------------------------------------------------------

import { bunpilotReady, bunpilotOnShutdown, bunpilotStartMetrics } from '../src/sdk/worker';

const PORT = Number(process.env.PORT) || 3000;
const startedAt = Date.now();

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (url.pathname === '/') {
      return Response.json({
        pid: process.pid,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        hostname: require('os').hostname(),
        port: PORT,
      });
    }

    return new Response('Not Found', { status: 404 });
  },
});

console.log(`[sample-server] listening on :${server.port} (pid=${process.pid})`);

// ---------------------------------------------------------------------------
// bunpilot SDK hooks
// ---------------------------------------------------------------------------

// Signal to bunpilot that the worker is ready to accept traffic.
bunpilotReady();

// Start periodic metrics reporting (every 5s by default).
bunpilotStartMetrics();

// Register graceful shutdown: close the server and drain connections.
bunpilotOnShutdown(async () => {
  console.log('[sample-server] shutting down gracefully...');
  server.stop(true); // close keep-alive connections
  await Bun.sleep(500); // allow in-flight requests to complete
  console.log('[sample-server] shutdown complete');
});
