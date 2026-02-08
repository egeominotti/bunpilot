// ---------------------------------------------------------------------------
// bunpm2 – Crashing Server Fixture
// ---------------------------------------------------------------------------
// Deliberately crashes after a random interval (2-10s) to exercise restart /
// backoff logic in bunpm2.
// ---------------------------------------------------------------------------

import { bunpm2Ready } from '../src/sdk/worker';

const PORT = Number(process.env.PORT) || 3001;

const crashAfterMs = Math.floor(Math.random() * 8_000) + 2_000; // 2-10s

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    return Response.json({ pid: process.pid, crashAfterMs });
  },
});

console.log(`[crashing-server] listening on :${server.port} – will crash in ~${crashAfterMs}ms`);

// Notify bunpm2 the worker is ready.
bunpm2Ready();

// Schedule the deliberate crash.
setTimeout(() => {
  console.error('[crashing-server] simulated crash!');
  process.exit(1);
}, crashAfterMs);
