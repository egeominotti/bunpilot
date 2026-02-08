#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// bunpm – Full Simulation Script
// ---------------------------------------------------------------------------
//
// Tests the core modules in isolation to verify they work correctly.
// Does NOT require the daemon – exercises internal APIs directly.
// ---------------------------------------------------------------------------

import { WorkerLifecycle } from '../src/core/lifecycle';
import { CrashRecovery } from '../src/core/backoff';
import { ProcessManager } from '../src/core/process-manager';
import { SqliteStore } from '../src/store/sqlite';
import { LogWriter } from '../src/logs/writer';
import { LogManager } from '../src/logs/manager';
import { MetricsAggregator } from '../src/metrics/aggregator';
import { formatPrometheus } from '../src/metrics/prometheus';
import { HealthChecker } from '../src/health/checker';
import { ControlServer } from '../src/control/server';
import { ControlClient } from '../src/control/client';
import { validateConfig, resolveInstances } from '../src/config/validator';
import { detectStrategy } from '../src/cluster/platform';
import { encodeMessage, decodeMessages, createRequest, createResponse } from '../src/control/protocol';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

function section(name: string): void {
  console.log(`\n${BOLD}--- ${name} ---${RESET}`);
}

function ok(label: string): void {
  passed++;
  console.log(`  ${GREEN}PASS${RESET} ${label}`);
}

function fail(label: string, err: unknown): void {
  failed++;
  console.log(`  ${RED}FAIL${RESET} ${label}: ${err instanceof Error ? err.message : String(err)}`);
}

function check(label: string, fn: () => void): void {
  try {
    fn();
    ok(label);
  } catch (e) {
    fail(label, e);
  }
}

async function checkAsync(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    ok(label);
  } catch (e) {
    fail(label, e);
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// 1. Config Validation
// ---------------------------------------------------------------------------
section('Config Validation');

check('validateConfig with single app', () => {
  const cfg = validateConfig({
    apps: [{ name: 'my-app', script: './scripts/http-server.ts' }],
  });
  assert(cfg.apps.length === 1, 'Expected 1 app');
  assert(cfg.apps[0].name === 'my-app', 'Wrong app name');
  assert(cfg.apps[0].maxRestarts === 15, `Default maxRestarts should be 15, got ${cfg.apps[0].maxRestarts}`);
});

check('validateConfig single-app shorthand', () => {
  const cfg = validateConfig({ name: 'shorthand', script: 'app.ts' });
  assert(cfg.apps.length === 1, 'Expected 1 app');
  assert(cfg.apps[0].name === 'shorthand', 'Wrong name');
});

check('validateConfig rejects missing script', () => {
  let threw = false;
  try {
    validateConfig({ apps: [{ name: 'bad' }] });
  } catch {
    threw = true;
  }
  assert(threw, 'Should have thrown for missing script');
});

check('resolveInstances', () => {
  assert(resolveInstances(4) === 4, 'Should pass through number');
  const maxCpus = resolveInstances('max');
  assert(maxCpus > 0 && maxCpus <= 256, `max should resolve to CPUs, got ${maxCpus}`);
});

// ---------------------------------------------------------------------------
// 2. Worker Lifecycle State Machine
// ---------------------------------------------------------------------------
section('Worker Lifecycle State Machine');

check('valid transitions', () => {
  const lc = new WorkerLifecycle();
  assert(lc.canTransition('spawning', 'starting'), 'spawning->starting');
  assert(lc.canTransition('starting', 'online'), 'starting->online');
  assert(lc.canTransition('online', 'draining'), 'online->draining');
  assert(lc.canTransition('online', 'crashed'), 'online->crashed');
  assert(lc.canTransition('stopped', 'spawning'), 'stopped->spawning');
});

check('invalid transitions', () => {
  const lc = new WorkerLifecycle();
  assert(!lc.canTransition('online', 'spawning'), 'online->spawning should be invalid');
  assert(!lc.canTransition('stopped', 'online'), 'stopped->online should be invalid');
});

check('transition fires listeners', () => {
  const lc = new WorkerLifecycle();
  let fired = false;
  lc.onStateChange((_id, _from, _to) => {
    fired = true;
  });
  lc.transition(1, 'spawning', 'starting');
  assert(fired, 'Listener should have fired');
});

// ---------------------------------------------------------------------------
// 3. Crash Recovery / Backoff
// ---------------------------------------------------------------------------
section('Crash Recovery / Backoff');

check('exponential backoff', () => {
  const cr = new CrashRecovery();
  const cfg = {
    name: 'test',
    script: 'test.ts',
    instances: 1 as const,
    maxRestarts: 10,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM' as const,
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
  };

  const r1 = cr.onWorkerCrash(0, cfg);
  assert(r1 === 'restart', 'First crash should return restart');

  const state = cr.getState(0)!;
  assert(state.consecutiveCrashes === 1, `Expected 1 crash, got ${state.consecutiveCrashes}`);
});

check('give up after maxRestarts', () => {
  const cr = new CrashRecovery();
  const cfg = {
    name: 'test',
    script: 'test.ts',
    instances: 1 as const,
    maxRestarts: 2,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM' as const,
    readyTimeout: 30_000,
    backoff: { initial: 100, multiplier: 2, max: 10_000 },
  };

  cr.onWorkerCrash(0, cfg);
  cr.onWorkerCrash(0, cfg);
  const r3 = cr.onWorkerCrash(0, cfg);
  assert(r3 === 'give-up', 'Should give up after maxRestarts');
});

// ---------------------------------------------------------------------------
// 4. Process Spawning
// ---------------------------------------------------------------------------
section('Process Spawning');

await checkAsync('spawn and kill a worker', async () => {
  const pm = new ProcessManager();
  const scriptPath = join(import.meta.dir, 'http-server.ts');

  const cfg = {
    name: 'spawn-test',
    script: scriptPath,
    instances: 1 as const,
    maxRestarts: 5,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM' as const,
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    port: 18900,
  };

  const worker = pm.spawnWorker(
    cfg,
    0,
    (_msg) => {},
    (_code, _signal) => {},
  );

  assert(worker.pid > 0, `Expected valid PID, got ${worker.pid}`);
  assert(pm.isRunning(worker.pid), 'Worker should be running');

  // Give it a moment to start
  await new Promise((r) => setTimeout(r, 500));

  // Try hitting the HTTP server
  try {
    const res = await fetch('http://localhost:18900/');
    const json = await res.json();
    assert(json.pid === worker.pid, `Expected PID ${worker.pid} in response`);
    ok('HTTP server responds with worker info');
  } catch (e) {
    fail('HTTP server responds', e);
  }

  // Health endpoint
  try {
    const res = await fetch('http://localhost:18900/health');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    ok('Health endpoint returns 200');
  } catch (e) {
    fail('Health endpoint', e);
  }

  // Kill the worker
  const result = await pm.killWorker(worker.pid, 'SIGTERM', 3_000);
  assert(result === 'exited' || result === 'killed', `Expected exited/killed, got ${result}`);
  assert(!pm.isRunning(worker.pid), 'Worker should not be running after kill');
});

// ---------------------------------------------------------------------------
// 5. SQLite Store
// ---------------------------------------------------------------------------
section('SQLite Store');

check('CRUD operations', () => {
  const store = new SqliteStore(':memory:');

  const appCfg = {
    name: 'db-test',
    script: 'test.ts',
    instances: 2 as const,
    maxRestarts: 5,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM' as const,
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
  };

  // Save and retrieve
  store.saveApp('db-test', appCfg);
  const app = store.getApp('db-test');
  assert(app !== null, 'App should exist');
  assert(app!.name === 'db-test', 'Wrong name');

  // Workers
  store.saveWorker('db-test', 0, 'online', 1234);
  store.saveWorker('db-test', 1, 'online', 1235);
  const workers = store.getWorkers('db-test');
  assert(workers.length === 2, `Expected 2 workers, got ${workers.length}`);

  // Status update
  store.updateAppStatus('db-test', 'running');
  const updated = store.getApp('db-test');
  assert(updated!.status === 'running', 'Status should be updated');

  // Restart history
  store.addRestartEntry('db-test', 0, 1234, 1, null, 5000, 'crash');
  const history = store.getRestartHistory('db-test');
  assert(history.length === 1, 'Should have 1 restart entry');

  // Metrics
  store.saveMetricSnapshot('db-test', 0, 50_000_000, 30_000_000, 12.5);

  // Cleanup
  store.deleteApp('db-test');
  assert(store.getApp('db-test') === null, 'App should be deleted');

  store.close();
});

// ---------------------------------------------------------------------------
// 6. Log Writer & Rotation
// ---------------------------------------------------------------------------
section('Log Writer & Rotation');

await checkAsync('write and rotate logs', async () => {
  const tmpDir = join(tmpdir(), `bunpm-sim-logs-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  const logPath = join(tmpDir, 'test.log');
  const writer = new LogWriter(logPath, 50, 3); // rotate at 50 bytes

  await writer.write('Line 1: some log data here\n'); // 27 bytes
  await writer.write('Line 2: more data to fill up\n'); // 29 bytes -> total 56 > 50

  // Next write triggers rotation
  await writer.write('Line 3: after rotation\n');

  assert(existsSync(logPath), 'Current log should exist');
  assert(existsSync(`${logPath}.1`), 'Rotated .1 should exist');

  writer.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 7. Metrics Aggregator
// ---------------------------------------------------------------------------
section('Metrics Aggregator');

check('aggregate and format prometheus', () => {
  const agg = new MetricsAggregator();

  agg.updateMetrics(0, {
    memory: { rss: 50_000_000, heapTotal: 40_000_000, heapUsed: 30_000_000, external: 1_000_000 },
    cpu: { user: 100_000, system: 50_000 },
  });

  const m = agg.getMetrics(0);
  assert(m !== null, 'Metrics should exist');
  assert(m!.memory.rss === 50_000_000, 'RSS should match');

  // Prometheus format
  const output = formatPrometheus([
    {
      appName: 'test-app',
      workers: [
        {
          workerId: 0,
          metrics: m!,
          restartCount: 2,
          uptime: 60_000,
          state: 'online',
        },
      ],
    },
  ]);

  assert(output.includes('bunpm_worker_memory_rss_bytes'), 'Should contain RSS metric');
  assert(output.includes('bunpm_worker_cpu_percent'), 'Should contain CPU metric');
  assert(output.includes('bunpm_master_uptime_seconds'), 'Should contain master uptime');
  assert(output.includes('test-app'), 'Should contain app name');
});

// ---------------------------------------------------------------------------
// 8. Control Protocol (NDJSON)
// ---------------------------------------------------------------------------
section('Control Protocol (NDJSON)');

check('encode/decode round-trip', () => {
  const req = createRequest('list');
  const encoded = encodeMessage(req);
  assert(encoded.endsWith('\n'), 'Should end with newline');

  const decoded = decodeMessages(encoded);
  assert(decoded.length === 1, 'Should decode 1 message');
  assert((decoded[0] as { cmd: string }).cmd === 'list', 'Command should be list');
});

check('response creation', () => {
  const ok = createResponse('test-id', { apps: [] });
  assert(ok.ok === true, 'Response should be ok');
  assert(ok.id === 'test-id', 'ID should match');
});

// ---------------------------------------------------------------------------
// 9. Control Server & Client
// ---------------------------------------------------------------------------
section('Control Server & Client');

await checkAsync('server accepts connections and responds', async () => {
  const tmpDir = join(tmpdir(), `bunpm-sim-sock-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
  const socketPath = join(tmpDir, 'test.sock');

  const server = new ControlServer(socketPath, async (req) => {
    return createResponse(req.id, { pong: true, cmd: req.cmd });
  });

  await server.start();

  // Client connects and sends a command
  const client = new ControlClient(socketPath);
  const response = await client.send('ping');

  assert(response.ok === true, 'Response should be ok');
  assert((response.data as { pong: boolean }).pong === true, 'Should get pong');

  await server.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 10. Health Checker
// ---------------------------------------------------------------------------
section('Health Checker');

check('heartbeat tracking', () => {
  const hc = new HealthChecker();
  hc.onHeartbeat(0);
  assert(!hc.isHeartbeatStale(0), 'Should not be stale immediately after heartbeat');
  hc.stopAll();
});

// ---------------------------------------------------------------------------
// 11. Platform Detection
// ---------------------------------------------------------------------------
section('Platform Detection');

check('cluster strategy detection', () => {
  const strategy = detectStrategy('auto');
  assert(
    strategy === 'reusePort' || strategy === 'proxy',
    `Should resolve to reusePort or proxy, got ${strategy}`,
  );

  const forced = detectStrategy('proxy');
  assert(forced === 'proxy', 'proxy should pass through');
});

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
