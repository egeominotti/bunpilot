// ---------------------------------------------------------------------------
// h58 – Status snapshots must not carry app env secrets outside the 0600 socket
// ---------------------------------------------------------------------------
//
// `toAppStatus()` is the ONLY projection used by MasterOrchestrator.listApps()
// and .getAppStatus() (src/core/master.ts:340-351). Daemon boot wires that very
// array into the unauthenticated loopback metrics HTTP server:
//
//   getJsonMetrics: () => master.listApps()
//   getStatus:      () => ({ apps: master.listApps(), ... })
//
// so every value in `config.env` (DATABASE_URL, STRIPE_KEY, ...) is served by
// `GET http://127.0.0.1:<metricsPort>/api/status` with no auth, bypassing the
// 0600 control socket that is supposed to be the administrative trust boundary.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { validateApp } from '../../src/config/validator';
import { createWorkerInfo, toAppStatus } from '../../src/core/app-status';
import type { ManagedApp } from '../../src/core/worker-handler';
import { type MetricsDataProvider, MetricsHttpServer } from '../../src/metrics/http-server';

// -- deterministic PRNG (mulberry32) ----------------------------------------
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeManaged(name: string, env: Record<string, string>, workers: number): ManagedApp {
  const config = validateApp({ name, script: 'worker.ts', instances: workers, env });
  const managed: ManagedApp = {
    config,
    workers: [],
    spawned: new Map(),
    startedAt: Date.now(),
    stableTimers: new Map(),
    readyTimers: new Map(),
    workerPorts: new Map(),
    launchTokens: new Map(),
    restartingWorkers: new Set(),
    stopping: false,
    nextWorkerId: workers,
  };
  for (let i = 0; i < workers; i++) {
    const w = createWorkerInfo(i);
    w.pid = 1000 + i;
    w.state = 'online';
    managed.workers.push(w);
  }
  return managed;
}

const servers: MetricsHttpServer[] = [];
afterAll(() => {
  for (const s of servers) {
    try {
      s.stop();
    } catch {
      /* ignore */
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Unit / property: the public status projection must not carry secret values
// ---------------------------------------------------------------------------

test('toAppStatus never carries raw env secret values into the public snapshot', () => {
  const SECRET_KEYS = ['DATABASE_URL', 'STRIPE_KEY', 'JWT_SECRET', 'AWS_SECRET_ACCESS_KEY'];

  for (let seed = 1; seed <= 60; seed++) {
    const rnd = prng(seed);
    const env: Record<string, string> = {};
    const secrets: string[] = [];

    const count = 1 + Math.floor(rnd() * SECRET_KEYS.length);
    for (let i = 0; i < count; i++) {
      const key = SECRET_KEYS[i] as string;
      const secret = `s3cr3t-${seed}-${Math.floor(rnd() * 1e9).toString(36)}`;
      env[key] = `postgres://u:${secret}@db/x`;
      secrets.push(secret);
    }
    // Non-secret env still allowed to be public; only values must not leak raw.
    env.NODE_ENV = 'production';

    const managed = makeManaged(`app-${seed}`, env, 1 + Math.floor(rnd() * 3));
    const status = toAppStatus(managed);
    const serialised = JSON.stringify(status);

    for (const secret of secrets) {
      if (serialised.includes(secret)) {
        console.error(`FAILING SEED: ${seed} (env=${JSON.stringify(env)})`);
      }
      expect(serialised).not.toContain(secret);
    }

    // Sanity: the snapshot is still a usable status object.
    expect(status.name).toBe(`app-${seed}`);
    expect(status.config.script).toBe('worker.ts');
    expect(status.status).toBe('running');
  }
});

// ---------------------------------------------------------------------------
// 2. Integration: the unauthenticated loopback HTTP server must not serve them
// ---------------------------------------------------------------------------

test('metrics HTTP /api/status and /api/metrics do not expose app env secrets', async () => {
  const managed = makeManaged(
    'api',
    {
      DATABASE_URL: 'postgres://u:SUPERSECRET@db/x',
      STRIPE_KEY: 'sk_live_abc',
    },
    2,
  );

  // Exactly how src/daemon/boot.ts builds the provider (boot.ts:70, 148-158).
  const listApps = () => [toAppStatus(managed)];
  const provider: MetricsDataProvider = {
    getPrometheusMetrics: () => '',
    getJsonMetrics: (appName) => {
      const apps = listApps();
      return appName ? apps.filter((a) => a.name === appName) : apps;
    },
    getStatus: () => ({ apps: listApps(), uptime: process.uptime(), pid: process.pid }),
  };

  // Ephemeral port: Bun.serve({ port: 0 }) picks a free one.
  const server = new MetricsHttpServer(0, provider);
  servers.push(server);
  server.start();
  const port = (server as unknown as { server: { port: number } }).server.port;
  expect(port).toBeGreaterThan(0);

  try {
    for (const path of ['/api/status', '/api/metrics', '/api/metrics/api']) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain('SUPERSECRET');
      expect(body).not.toContain('sk_live_abc');
    }
  } finally {
    server.stop();
  }
});
