// Simple HTTP server for bunpilot testing
// Responds with worker info on every request

const workerId = process.env.BUNPILOT_WORKER_ID ?? 'standalone';
const port = parseInt(process.env.BUNPILOT_PORT ?? '3000', 10);
const appName = process.env.BUNPILOT_APP_NAME ?? 'unknown';

const server = Bun.serve({
  port,
  reusePort: process.env.BUNPILOT_REUSE_PORT === '1',
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }

    return Response.json({
      app: appName,
      worker: workerId,
      pid: process.pid,
      uptime: process.uptime(),
      port,
      timestamp: new Date().toISOString(),
    });
  },
});

console.log(`[worker:${workerId}] HTTP server listening on port ${port} (pid ${process.pid})`);

// Notify master that we're ready (if running under bunpilot)
if (typeof process.send === 'function') {
  process.send({ type: 'ready' });
}

// Handle graceful shutdown from master
process.on('message', (msg: unknown) => {
  if (typeof msg === 'object' && msg !== null && (msg as { type: string }).type === 'shutdown') {
    console.log(`[worker:${workerId}] Received shutdown signal, closing...`);
    server.stop(true);
    process.exit(0);
  }
});
