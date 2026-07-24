// ---------------------------------------------------------------------------
// bunpilot – "bunqueue" worker fixture
// ---------------------------------------------------------------------------
// A minimal Bun-native job-queue worker that bunpilot manages and analyzes in
// depth. It continuously pulls jobs off an in-memory queue and processes them,
// which churns the heap (allocations + reclaim), keeps the event loop busy, and
// grows/shrinks ArrayBuffers — so the deep telemetry (heap composition, derived
// GC pressure, event-loop / stack health) reported to the master reflects real
// runtime behaviour.
//
// Run under bunpilot:  bunpilot start fixtures/bunqueue-server.ts --name bunqueue
// ---------------------------------------------------------------------------

import { bunpilotOnShutdown, bunpilotReady, bunpilotStartMetrics } from '../src/sdk/worker';

interface Job {
  id: number;
  payload: string;
}

const queue: Job[] = [];
let nextJobId = 0;
let processed = 0;
let draining = false;

/** A running set of retained buffers, so heap growth and reclaim both show up. */
let retained: Uint8Array[] = [];

/** Enqueue a batch of synthetic jobs. */
function enqueueBatch(n: number): void {
  for (let i = 0; i < n; i++) {
    queue.push({ id: nextJobId++, payload: 'x'.repeat(256 + (nextJobId % 512)) });
  }
}

/** Process one job: allocate, transform, occasionally retain/release memory. */
function processJob(job: Job): void {
  // Allocate transient objects (heap churn -> allocation rate + GC reclaim).
  const words = job.payload.split('').map((c, i) => ({ c, i, hash: (i * 31) ^ job.id }));
  const digest = words.reduce((acc, w) => (acc + w.hash) >>> 0, 0);

  // Grow an ArrayBuffer working set, then periodically release it so the heap
  // both grows and is reclaimed (visible as gc.reclaimedBytes / inferred GCs).
  retained.push(new Uint8Array(1024).fill(digest & 0xff));
  if (retained.length > 512) retained = retained.slice(retained.length / 2);

  processed += 1;
}

/** The queue pump: drains available jobs, refilling when empty. */
function pump(): void {
  if (draining) return;
  if (queue.length === 0) enqueueBatch(200);
  const budget = Math.min(queue.length, 50);
  for (let i = 0; i < budget; i++) {
    const job = queue.shift();
    if (job) processJob(job);
  }
}

const pumpTimer = setInterval(pump, 25);
pumpTimer.unref?.();

// Optional HTTP surface so a health check / manual poke can observe progress.
const PORT = Number(process.env.BUNPILOT_PORT ?? process.env.PORT) || 0;
const server =
  PORT > 0
    ? Bun.serve({
        port: PORT,
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/health') return new Response('ok');
          return Response.json({ pid: process.pid, processed, queued: queue.length });
        },
      })
    : null;

console.log(`[bunqueue] worker up (pid=${process.pid})${server ? ` on :${server.port}` : ''}`);

// ---------------------------------------------------------------------------
// bunpilot SDK hooks — enable DEEP telemetry so the master can analyze heap,
// GC pressure and event-loop / stack health in depth.
// ---------------------------------------------------------------------------

bunpilotReady();
bunpilotStartMetrics(2_000, { deep: true });

bunpilotOnShutdown(async () => {
  draining = true;
  clearInterval(pumpTimer);
  server?.stop(true);
  // Drain whatever is left in the queue before exiting.
  while (queue.length > 0) {
    const job = queue.shift();
    if (job) processJob(job);
  }
  retained = [];
  console.log(`[bunqueue] drained; processed ${processed} jobs`);
});
