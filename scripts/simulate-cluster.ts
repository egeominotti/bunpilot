#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// bunpilot – Cluster Simulation Script
// ---------------------------------------------------------------------------
//
// Spawns multiple workers via ProcessManager, wires up ProxyCluster to
// round-robin requests across them, then verifies that HTTP requests
// arriving on the public port are distributed to different workers.
// ---------------------------------------------------------------------------

import { ProcessManager } from '../src/core/process-manager';
import { ProxyCluster } from '../src/cluster/proxy';
import { join } from 'node:path';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function ok(label: string): void {
  passed++;
  console.log(`  ${GREEN}PASS${RESET} ${label}`);
}

function fail(label: string, err: unknown): void {
  failed++;
  console.log(`  ${RED}FAIL${RESET} ${label}: ${err instanceof Error ? err.message : String(err)}`);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKER_COUNT = 3;
const PUBLIC_PORT = 18800;
const INTERNAL_PORT_BASE = 40_001; // Must match src/constants.ts
const scriptPath = join(import.meta.dir, 'http-server.ts');

console.log(`\n${BOLD}=== bunpilot Cluster Simulation ===${RESET}`);
console.log(`  Workers: ${WORKER_COUNT}`);
console.log(`  Public port: ${PUBLIC_PORT}`);
console.log(`  Internal ports: ${INTERNAL_PORT_BASE}–${INTERNAL_PORT_BASE + WORKER_COUNT - 1}`);
console.log(`  Script: ${scriptPath}\n`);

// ---------------------------------------------------------------------------
// 1. Spawn workers on internal ports
// ---------------------------------------------------------------------------

console.log(`${BOLD}--- Spawning ${WORKER_COUNT} workers ---${RESET}`);

const pm = new ProcessManager();
const proxy = new ProxyCluster();

interface WorkerInfo {
  spawnPid: number;
  workerId: number;
  port: number;
  actualPid?: number; // Discovered from HTTP response
}

const workers: WorkerInfo[] = [];

for (let i = 0; i < WORKER_COUNT; i++) {
  const internalPort = INTERNAL_PORT_BASE + i;

  const cfg = {
    name: 'cluster-test',
    script: scriptPath,
    instances: WORKER_COUNT as any,
    maxRestarts: 5,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM' as const,
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    port: internalPort,
  };

  const worker = pm.spawnWorker(
    cfg,
    i,
    (_id, _msg) => {},
    (_id, _code, _signal) => {},
  );

  workers.push({ spawnPid: worker.pid, workerId: i, port: internalPort });
  console.log(`  Worker ${i}: spawn PID ${worker.pid}, port ${internalPort}`);
}

// Give workers time to start their HTTP servers
console.log(`\n${YELLOW}  Waiting 1.5s for workers to start...${RESET}`);
await new Promise((r) => setTimeout(r, 1500));

// ---------------------------------------------------------------------------
// 2. Verify each worker responds on its internal port
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Verifying internal ports ---${RESET}`);

for (const w of workers) {
  try {
    const res = await fetch(`http://localhost:${w.port}/`);
    const json = (await res.json()) as { pid: number; worker: string };
    w.actualPid = json.pid;
    ok(`Worker ${w.workerId} responds on port ${w.port} (PID ${json.pid})`);
  } catch (e) {
    fail(`Worker ${w.workerId} on port ${w.port}`, e);
  }
}

// Verify all workers have unique PIDs
const uniqueWorkerPids = new Set(workers.map((w) => w.actualPid).filter(Boolean));
if (uniqueWorkerPids.size === WORKER_COUNT) {
  ok(`All ${WORKER_COUNT} workers have unique PIDs`);
} else {
  fail('Unique PIDs', `Expected ${WORKER_COUNT} unique PIDs, got ${uniqueWorkerPids.size}`);
}

// ---------------------------------------------------------------------------
// 3. Start ProxyCluster on the public port
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Starting ProxyCluster on port ${PUBLIC_PORT} ---${RESET}`);

proxy.start(PUBLIC_PORT, WORKER_COUNT);

// Mark all workers as alive
for (let i = 0; i < WORKER_COUNT; i++) {
  proxy.addWorker(i);
}

ok(`ProxyCluster started with ${WORKER_COUNT} workers`);

// Give proxy a moment to bind
await new Promise((r) => setTimeout(r, 300));

// ---------------------------------------------------------------------------
// 4. Send requests through the proxy and check round-robin distribution
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Testing round-robin distribution ---${RESET}`);

const REQUEST_COUNT = WORKER_COUNT * 3; // 9 requests across 3 workers
const pidCounts = new Map<number, number>();

for (let i = 0; i < REQUEST_COUNT; i++) {
  try {
    // Force a new TCP connection per request so round-robin distributes properly.
    // Without this, HTTP keep-alive reuses the same connection (same worker).
    const res = await fetch(`http://localhost:${PUBLIC_PORT}/`, {
      headers: { Connection: 'close' },
    });
    const json = (await res.json()) as { pid: number; worker: string };
    const pid = json.pid;
    pidCounts.set(pid, (pidCounts.get(pid) ?? 0) + 1);
  } catch (e) {
    fail(`Request ${i + 1} through proxy`, e);
  }
}

// Check that we hit all workers
const uniqueProxyPids = pidCounts.size;

if (uniqueProxyPids === WORKER_COUNT) {
  ok(`All ${WORKER_COUNT} workers received traffic (${uniqueProxyPids} unique PIDs)`);
} else if (uniqueProxyPids > 1) {
  ok(`Traffic distributed across ${uniqueProxyPids}/${WORKER_COUNT} workers`);
} else {
  fail(
    'Round-robin distribution',
    `Expected ${WORKER_COUNT} unique PIDs, got ${uniqueProxyPids}: ${JSON.stringify([...pidCounts])}`,
  );
}

// Log the distribution
console.log(`\n  ${BOLD}Distribution:${RESET}`);
for (const w of workers) {
  const pid = w.actualPid ?? w.spawnPid;
  const count = pidCounts.get(pid) ?? 0;
  const bar = '█'.repeat(count) + '░'.repeat(REQUEST_COUNT - count);
  console.log(`    Worker ${w.workerId} (PID ${pid}): ${count}/${REQUEST_COUNT} ${bar}`);
}

// Check fairness
const expectedPerWorker = REQUEST_COUNT / WORKER_COUNT;
let fairnessOk = true;
for (const w of workers) {
  const pid = w.actualPid ?? w.spawnPid;
  const count = pidCounts.get(pid) ?? 0;
  if (count !== expectedPerWorker) fairnessOk = false;
}

if (fairnessOk) {
  ok(`Perfect round-robin: each worker got exactly ${expectedPerWorker} requests`);
} else {
  console.log(`  ${YELLOW}NOTE${RESET} Distribution not perfectly even (connection reuse may cause this)`);
}

// ---------------------------------------------------------------------------
// 5. Test health endpoint through proxy
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Health check through proxy ---${RESET}`);

try {
  const res = await fetch(`http://localhost:${PUBLIC_PORT}/health`, {
    headers: { Connection: 'close' },
  });
  if (res.status === 200) {
    ok('Health endpoint returns 200 through proxy');
  } else {
    fail('Health endpoint', `Expected 200, got ${res.status}`);
  }
} catch (e) {
  fail('Health endpoint through proxy', e);
}

// ---------------------------------------------------------------------------
// 6. Test removing a worker from the pool
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Removing worker 0 from pool ---${RESET}`);

proxy.removeWorker(0);

// Send requests and verify worker 0 no longer receives traffic
const pidsAfterRemove = new Set<number>();
for (let i = 0; i < WORKER_COUNT * 2; i++) {
  try {
    const res = await fetch(`http://localhost:${PUBLIC_PORT}/`, {
      headers: { Connection: 'close' },
    });
    const json = (await res.json()) as { pid: number };
    pidsAfterRemove.add(json.pid);
  } catch (e) {
    fail(`Request after removal ${i}`, e);
  }
}

const removedPid = workers[0].actualPid ?? workers[0].spawnPid;
if (!pidsAfterRemove.has(removedPid)) {
  ok(`Worker 0 (PID ${removedPid}) no longer receives traffic`);
} else {
  fail('Worker removal', `Worker 0 (PID ${removedPid}) still received traffic after removal`);
}

if (pidsAfterRemove.size === WORKER_COUNT - 1) {
  ok(`Remaining ${WORKER_COUNT - 1} workers still receive traffic`);
} else {
  fail('Remaining workers', `Expected ${WORKER_COUNT - 1} active workers, got ${pidsAfterRemove.size}`);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Cleanup ---${RESET}`);

proxy.stop();
ok('ProxyCluster stopped');

// Kill all workers using the spawn PID (which is what ProcessManager tracks)
for (const w of workers) {
  try {
    const result = await pm.killWorker(w.spawnPid, 'SIGTERM', 3_000);
    ok(`Worker ${w.workerId} (spawn PID ${w.spawnPid}) ${result}`);
  } catch (e) {
    fail(`Kill worker ${w.workerId}`, e);
  }
}

// Also kill any actual worker PIDs that differ from spawn PIDs
for (const w of workers) {
  if (w.actualPid && w.actualPid !== w.spawnPid) {
    try {
      process.kill(w.actualPid, 'SIGTERM');
    } catch {
      // Already dead
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}========================================${RESET}`);
console.log(
  `${BOLD}Results:${RESET} ${GREEN}${passed} passed${RESET}, ${failed > 0 ? RED : GREEN}${failed} failed${RESET}`,
);
console.log(`${BOLD}========================================${RESET}\n`);

if (failed > 0) {
  process.exit(1);
}
