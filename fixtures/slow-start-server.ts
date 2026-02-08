// ---------------------------------------------------------------------------
// bunpilot – Slow Start Server Fixture
// ---------------------------------------------------------------------------
// Simulates a long initialization phase (5s) before signalling readiness.
// Useful for testing the `readyTimeout` configuration option.
// ---------------------------------------------------------------------------

import { bunpilotReady, bunpilotOnShutdown, bunpilotStartMetrics } from '../src/sdk/worker';

const PORT = Number(process.env.PORT) || 3002;
const STARTUP_DELAY_MS = 5_000;

async function main() {
  console.log(`[slow-start] initializing... (simulated delay: ${STARTUP_DELAY_MS}ms)`);

  // Simulate heavy init work (DB migrations, cache warm-up, etc.).
  await Bun.sleep(STARTUP_DELAY_MS);

  const server = Bun.serve({
    port: PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/health') {
        return new Response('ok', { status: 200 });
      }

      return Response.json({ pid: process.pid, startupDelayMs: STARTUP_DELAY_MS });
    },
  });

  console.log(`[slow-start] ready on :${server.port} (pid=${process.pid})`);

  bunpilotReady();
  bunpilotStartMetrics();

  bunpilotOnShutdown(async () => {
    console.log('[slow-start] shutting down...');
    server.stop(true);
  });
}

main();
