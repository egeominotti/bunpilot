// ---------------------------------------------------------------------------
// h24 — Secrets must never leave the daemon over the unauthenticated
//       loopback metrics HTTP server.
// ---------------------------------------------------------------------------
//
// Invariant under test:
//   The control socket is chmod 0600 (src/control/server.ts:101) precisely so
//   that only the owning user can read daemon state. The metrics HTTP server
//   (src/metrics/http-server.ts) binds 127.0.0.1 with NO auth, NO uid check —
//   every local uid can connect. Therefore anything reachable through the
//   metrics server must not contain app secrets (AppConfig.env values).
//
// This test wires a MetricsDataProvider EXACTLY as src/daemon/boot.ts:152-160
// does (getJsonMetrics -> master.listApps(), getStatus -> snapshot()), using
// the real toAppStatus() the orchestrator uses, and asserts no env value is
// echoed back over HTTP.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import type { AppConfig, AppStatus } from '../../src/config/types';
import { validateApp } from '../../src/config/validator';
import { toAppStatus } from '../../src/core/app-status';
import type { ManagedApp } from '../../src/core/worker-handler';
import { type MetricsDataProvider, MetricsHttpServer } from '../../src/metrics/http-server';
import { formatPrometheus } from '../../src/metrics/prometheus';

// -- seeded deterministic PRNG (mulberry32) ---------------------------------

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SECRET_KEYS = [
  'DATABASE_URL',
  'STRIPE_SECRET_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'JWT_SIGNING_KEY',
  'REDIS_PASSWORD',
];

function makeSecret(rng: () => number, tag: string): string {
  const n = Math.floor(rng() * 0xffffffff).toString(36);
  return `SUPERSECRET-${tag}-${n}`;
}

// -- helpers ----------------------------------------------------------------

/** Minimal ManagedApp with no live workers — enough for toAppStatus(). */
function managedFor(config: AppConfig): ManagedApp {
  return {
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
    nextWorkerId: 1,
  };
}

const servers: MetricsHttpServer[] = [];

afterAll(() => {
  for (const s of servers) {
    try {
      s.stop();
    } catch {
      /* already stopped */
    }
  }
});

/** Start the metrics server on an ephemeral high port (retry on collision). */
function startOnFreePort(provider: MetricsDataProvider, rng: () => number): number {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = 20000 + Math.floor(rng() * 30000);
    const server = new MetricsHttpServer(port, provider);
    try {
      server.start();
    } catch {
      continue; // EADDRINUSE — try another port
    }
    servers.push(server);
    return port;
  }
  throw new Error('could not bind an ephemeral port');
}

// ---------------------------------------------------------------------------

test('metrics HTTP server never exposes AppConfig.env secrets (unauthenticated loopback)', async () => {
  const seeds = [1, 7, 42, 1337, 90210];

  for (const seed of seeds) {
    const rng = makeRng(seed);

    // --- generate a random fleet of apps, each with secret env vars ---------
    const appCount = 1 + Math.floor(rng() * 3);
    const configs: AppConfig[] = [];
    const secrets: string[] = [];

    for (let i = 0; i < appCount; i++) {
      const name = `app-${seed}-${i}`;
      const env: Record<string, string> = {};
      const keyCount = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < keyCount; k++) {
        const key = SECRET_KEYS[Math.floor(rng() * SECRET_KEYS.length)] as string;
        const value = makeSecret(rng, `${seed}-${i}-${k}`);
        env[key] = value;
        secrets.push(value);
      }
      configs.push(
        validateApp({
          name,
          script: `/private/tmp/h24-${name}.ts`,
          env,
        }),
      );
    }

    const statuses: AppStatus[] = configs.map((c) => toAppStatus(managedFor(c)));

    // --- provider wired EXACTLY as src/daemon/boot.ts:152-160 --------------
    const snapshot = () => ({ apps: statuses, uptime: 1, pid: 1 });
    const provider: MetricsDataProvider = {
      getPrometheusMetrics: () =>
        formatPrometheus(statuses.map((a) => ({ appName: a.name, workers: [] }))),
      getJsonMetrics: (appName?: string) =>
        appName ? statuses.filter((a) => a.name === appName) : statuses,
      getStatus: () => snapshot(),
    };

    const port = startOnFreePort(provider, rng);
    const base = `http://127.0.0.1:${port}`;

    const routes = [
      '/api/status',
      '/api/metrics',
      ...configs.map((c) => `/api/metrics/${encodeURIComponent(c.name)}`),
    ];

    for (const route of routes) {
      const res = await fetch(base + route);
      const body = await res.text();
      for (const secret of secrets) {
        expect(
          body.includes(secret),
          `seed=${seed} route=${route}: unauthenticated loopback response leaked env secret ${JSON.stringify(
            secret,
          )} (body starts: ${body.slice(0, 400)})`,
        ).toBe(false);
      }
    }
  }
}, 20000);
