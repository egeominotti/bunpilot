// ---------------------------------------------------------------------------
// bunpilot – Realistic end-to-end: real daemon manages "bunqueue" and serves
//            its deep telemetry over the metrics HTTP server
// ---------------------------------------------------------------------------
//
// This is a full-stack test — no stubs. It boots the REAL daemon (bootDaemon)
// in a subprocess against a private BUNPILOT_HOME, which:
//   - starts the bunqueue worker from the config file,
//   - the worker (fixtures/bunqueue-server.ts) reports deep telemetry via the
//     SDK over IPC,
//   - the daemon aggregates it and serves it on the loopback metrics server.
//
// The test then scrapes the live endpoints exactly as an operator / Prometheus
// would and asserts:
//   1. GET /metrics    exposes the deep heap / GC / stack metric families.
//   2. GET /api/metrics returns the per-object-type heap census as JSON.
//   3. Neither endpoint leaks the app's env secret (unauthenticated loopback).
//   4. GET /api/status reports the app running with a live pid.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ControlClient } from '../../src/control/client';
import { makeTempDir } from '../_helpers/tmp';

const REPO = join(import.meta.dir, '..', '..');
const FIXTURE = join(REPO, 'fixtures', 'bunqueue-server.ts');
const BOOT = join(REPO, 'src', 'daemon', 'boot.ts');

const HOME = makeTempDir('bunqueue-e2e-');
const SOCKET = join(HOME, 's.sock');
const CONFIG_PATH = join(HOME, 'bunpilot.config.ts');
const METRICS_PORT = 21_000 + Math.floor(Math.random() * 15_000);
const SECRET = `SUPERSECRET-${METRICS_PORT}-token`;

let daemon: ReturnType<typeof Bun.spawn> | null = null;

afterAll(async () => {
  try {
    if (daemon) {
      // Ask the daemon to shut down cleanly, then hard-kill as a backstop.
      await new ControlClient(SOCKET).send('shutdown').catch(() => {});
      daemon.kill('SIGKILL');
    }
  } catch {
    /* ignore */
  }
  try {
    rmSync(HOME, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if (await pred()) return true;
    } catch {
      /* keep polling */
    }
    await Bun.sleep(150);
  }
  return false;
}

async function fetchText(path: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${METRICS_PORT}${path}`);
  return res.text();
}

test('the real daemon serves a bunqueue worker’s deep telemetry over /metrics and /api/metrics', async () => {
  // -- config: one bunqueue app, metrics server on, secret env --------------
  writeFileSync(
    CONFIG_PATH,
    `export default ${JSON.stringify(
      {
        daemon: { socketFile: SOCKET, pidFile: join(HOME, 'd.pid') },
        apps: [
          {
            name: 'bunqueue',
            script: FIXTURE,
            instances: 1,
            minUptime: 0,
            healthCheck: { enabled: false },
            clustering: {
              enabled: false,
              strategy: 'auto',
              rollingRestart: { batchSize: 1, batchDelay: 0 },
            },
            metrics: {
              enabled: true,
              httpPort: METRICS_PORT,
              prometheus: true,
              collectInterval: 1000,
            },
            env: { QUEUE_SECRET: SECRET },
          },
        ],
      },
      null,
      2,
    )};\n`,
  );

  // -- boot the real daemon in a subprocess ---------------------------------
  const entry = join(HOME, 'entry.ts');
  writeFileSync(
    entry,
    `import { bootDaemon } from ${JSON.stringify(BOOT)};\n` +
      `await bootDaemon(${JSON.stringify(CONFIG_PATH)});\n`,
  );
  daemon = Bun.spawn(['bun', entry], {
    cwd: HOME,
    env: { ...process.env, BUNPILOT_HOME: HOME, BUNPILOT_SOCKET: SOCKET },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // -- daemon is up (control socket answers) --------------------------------
  const client = new ControlClient(SOCKET);
  const up = await waitFor(
    async () => existsSync(SOCKET) && (await client.send('list')).ok,
    15_000,
  );
  expect(up, 'daemon did not come up within 15s').toBe(true);

  // -- deep telemetry appears on the live Prometheus endpoint ----------------
  const hasDeepTelemetry = await waitFor(async () => {
    const body = await fetchText('/metrics');
    return body.includes('bunpilot_worker_heap_size_bytes{app="bunqueue"');
  }, 15_000);
  expect(hasDeepTelemetry, 'deep telemetry never reached /metrics').toBe(true);

  // -- 1. Prometheus exposition carries heap / GC / stack families ----------
  const prom = await fetchText('/metrics');
  expect(prom).toContain('bunpilot_worker_heap_size_bytes{app="bunqueue"');
  expect(prom).toContain('bunpilot_worker_heap_limit_bytes{app="bunqueue"');
  expect(prom).toContain('bunpilot_worker_gc_heap_utilization{app="bunqueue"');
  expect(prom).toContain('bunpilot_worker_event_loop_lag_ms{app="bunqueue"');
  expect(prom).toContain('bunpilot_worker_heap_object_type_count{app="bunqueue"');
  // Prometheus rejects duplicate series; every emitted line must be unique.
  const seriesLines = prom.split('\n').filter((l) => l.startsWith('bunpilot_worker_'));
  expect(new Set(seriesLines).size).toBe(seriesLines.length);

  // -- 2. JSON metrics carry the deep heap census ---------------------------
  const apiRaw = await fetchText('/api/metrics');
  const apps = JSON.parse(apiRaw) as Array<{
    name: string;
    workers: Array<{
      telemetry: {
        heap: { topObjectTypes: Array<{ type: string; count: number }> };
        gc: { heapUtilization: number };
        stack: { eventLoopLagMs: number };
      } | null;
    }>;
  }>;
  const bq = apps.find((a) => a.name === 'bunqueue');
  expect(bq).toBeDefined();
  const t = bq!.workers[0]?.telemetry;
  expect(t, 'worker telemetry missing from /api/metrics').not.toBeNull();
  expect(t!.heap.topObjectTypes.length).toBeGreaterThan(0);
  expect(Number.isFinite(t!.gc.heapUtilization)).toBe(true);
  expect(t!.stack.eventLoopLagMs).toBeGreaterThanOrEqual(0);

  // -- 3. No env secret leaks over the unauthenticated loopback -------------
  const status = await fetchText('/api/status');
  expect(prom.includes(SECRET)).toBe(false);
  expect(apiRaw.includes(SECRET)).toBe(false);
  expect(status.includes(SECRET)).toBe(false);

  // -- 4. status reports the app running with a live pid --------------------
  const parsedStatus = JSON.parse(status) as {
    apps: Array<{ name: string; status: string; workers: Array<{ pid: number }> }>;
  };
  const app = parsedStatus.apps.find((a) => a.name === 'bunqueue');
  expect(app?.status).toBe('running');
  expect(app?.workers[0]?.pid).toBeGreaterThan(0);
}, 45_000);
