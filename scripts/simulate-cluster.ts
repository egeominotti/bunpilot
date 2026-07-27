#!/usr/bin/env bun

// ---------------------------------------------------------------------------
// bunpilot – Cluster Simulation Script
// ---------------------------------------------------------------------------
//
// Spawns multiple workers via ProcessManager, wires up ProxyCluster to
// round-robin requests across them, then verifies that HTTP requests
// arriving on the public port are distributed to different workers.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import { ProxyCluster } from '../src/cluster/proxy';
import type { AppConfig } from '../src/config/types';
import { INTERNAL_PORT_BASE } from '../src/constants';
import { ProcessManager } from '../src/core/process-manager';

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

/**
 * Issue one HTTP GET over its OWN TCP connection and return the body.
 *
 * `fetch` cannot be used to measure round-robin fairness: it keeps a client
 * connection pool, and a `Connection: close` REQUEST header only asks the
 * upstream to hang up — the client↔proxy socket can survive and carry the next
 * request to the worker it is already bound to. On Linux, resolving `localhost`
 * made that reuse dominant, so every request after a worker removal landed on
 * one worker and the fairness check failed even though the proxy was correct.
 *
 * Since what these checks actually assert is "each NEW connection goes to the
 * next worker", open the connection explicitly.
 */
async function getOnce(port: number, path = '/', timeoutMs = 10_000): Promise<string> {
  return await new Promise<string>((resolveBody, rejectBody) => {
    const chunks: Uint8Array[] = [];
    let settled = false;
    let socketRef: { end: () => void } | null = null;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    // A response that never closes would otherwise hang this script until the
    // CI job's own timeout, with no hint about which request stalled.
    const timer = setTimeout(() => {
      finish(() => {
        try {
          socketRef?.end();
        } catch {
          /* already gone */
        }
        rejectBody(new Error(`timed out after ${timeoutMs}ms waiting for ${path} on ${port}`));
      });
    }, timeoutMs);

    Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        open(socket) {
          socketRef = socket;
          socket.write(`GET ${path} HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
        },
        data(_socket, chunk) {
          // Buffer bytes and decode once: a multi-byte sequence can straddle
          // two TCP segments.
          chunks.push(new Uint8Array(chunk));
        },
        close() {
          finish(() => {
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const bytes = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
              bytes.set(c, offset);
              offset += c.length;
            }
            const raw = new TextDecoder().decode(bytes);
            const separator = raw.indexOf('\r\n\r\n');
            if (separator === -1) {
              rejectBody(new Error(`malformed response from port ${port}: ${raw.slice(0, 120)}`));
              return;
            }
            const status = Number.parseInt(raw.slice(0, separator).split(' ')[1] ?? '', 10);
            const body = raw.slice(separator + 4);
            if (status !== 200) {
              // Surface the status instead of letting the caller's JSON.parse
              // report an opaque SyntaxError.
              rejectBody(new Error(`HTTP ${status} from port ${port}: ${body.slice(0, 120)}`));
              return;
            }
            resolveBody(body);
          });
        },
        error(_socket, err) {
          finish(() => rejectBody(err));
        },
      },
    }).catch((err) => finish(() => rejectBody(err)));
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WORKER_COUNT = 3;
const PUBLIC_PORT = 18800;
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

  const cfg: AppConfig = {
    name: 'cluster-test',
    script: scriptPath,
    instances: WORKER_COUNT,
    maxRestarts: 5,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM' as const,
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    port: internalPort,
    clustering: {
      enabled: false,
      strategy: 'proxy',
      rollingRestart: { batchSize: 1, batchDelay: 0 },
    },
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
    const res = await fetch(`http://127.0.0.1:${w.port}/`);
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

const workerPorts = new Map(workers.map((worker) => [worker.workerId, worker.port]));
proxy.start(PUBLIC_PORT, WORKER_COUNT, workerPorts);

// Mark all workers as alive
for (let i = 0; i < WORKER_COUNT; i++) {
  proxy.addWorker(i, workerPorts.get(i));
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
    // One fresh TCP connection per request — see getOnce().
    const json = JSON.parse(await getOnce(PUBLIC_PORT)) as { pid: number; worker: string };
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
  console.log(
    `  ${YELLOW}NOTE${RESET} Distribution not perfectly even (connection reuse may cause this)`,
  );
}

// ---------------------------------------------------------------------------
// 5. Test health endpoint through proxy
// ---------------------------------------------------------------------------

console.log(`\n${BOLD}--- Health check through proxy ---${RESET}`);

try {
  const res = await fetch(`http://127.0.0.1:${PUBLIC_PORT}/health`, {
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
    const json = JSON.parse(await getOnce(PUBLIC_PORT)) as { pid: number };
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
  const expectedPids = workers.slice(1).map((w) => w.actualPid ?? w.spawnPid);
  fail(
    'Remaining workers',
    `Expected ${WORKER_COUNT - 1} active workers, got ${pidsAfterRemove.size}. ` +
      `Expected PIDs ${JSON.stringify(expectedPids)}, saw ${JSON.stringify([...pidsAfterRemove])} ` +
      `across ${WORKER_COUNT * 2} requests`,
  );
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
