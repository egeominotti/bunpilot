import { bunpilotReady, bunpilotOnShutdown, bunpilotStartMetrics } from '../src/sdk/worker';

const PORT = Number(process.env.BUNPILOT_PORT) || 3000;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response('ok');
    }

    if (url.pathname === '/json') {
      return Response.json({
        message: 'Hello from bunpilot!',
        pid: process.pid,
        port: PORT,
        uptime: process.uptime(),
      });
    }

    return new Response(`bunpilot demo server - PID ${process.pid} on :${PORT}\n`);
  },
});

console.log(`[demo] server listening on http://localhost:${server.port} (pid=${process.pid})`);

bunpilotReady();
bunpilotStartMetrics();

bunpilotOnShutdown(async () => {
  console.log('[demo] shutting down gracefully...');
  server.stop(true);
});
