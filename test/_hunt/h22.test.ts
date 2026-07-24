import { afterAll, expect, test } from 'bun:test';
import type { AppStatus } from '../../src/config/types';
import { validateApp } from '../../src/config/validator';
import { toAppStatus } from '../../src/core/app-status';
import type { ManagedApp } from '../../src/core/worker-handler';
import { type MetricsDataProvider, MetricsHttpServer } from '../../src/metrics/http-server';

// ---------------------------------------------------------------------------
// Invariant under test
// ---------------------------------------------------------------------------
// The control socket is chmod 0600 because it is "the daemon's administrative
// trust boundary" (src/control/server.ts). The metrics HTTP listener exposes
// the *same* AppStatus objects (boot.ts wires getStatus/getJsonMetrics to
// master.listApps()/snapshot()), but is reachable by ANY local uid over
// 127.0.0.1 with no auth. Therefore the HTTP surface must never emit the
// values of AppConfig.env.
// ---------------------------------------------------------------------------

// Deterministic PRNG (mulberry32) so failures are reproducible from the seed.
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

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomToken(rng: () => number, len: number): string {
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[Math.floor(rng() * ALPHABET.length)]!;
  }
  return out;
}

function managedFrom(config: ReturnType<typeof validateApp>): ManagedApp {
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
      /* ignore */
    }
  }
});

async function startOnFreePort(provider: MetricsDataProvider): Promise<{
  server: MetricsHttpServer;
  port: number;
}> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = new MetricsHttpServer(port, provider);
    try {
      server.start();
      servers.push(server);
      return { server, port };
    } catch (error) {
      lastErr = error;
    }
  }
  throw new Error(`could not bind metrics server: ${String(lastErr)}`);
}

test('status and metrics endpoints never expose app env values', async () => {
  const BASE_SEED = 0xb0_0b_5;

  for (let iter = 0; iter < 25; iter++) {
    const seed = BASE_SEED + iter;
    const rng = makeRng(seed);

    // Generate 1..3 apps, each carrying secret-bearing env values.
    const appCount = 1 + Math.floor(rng() * 3);
    const secrets: string[] = [];
    const statuses: AppStatus[] = [];

    for (let i = 0; i < appCount; i++) {
      const env: Record<string, string> = {};
      const keys = ['DATABASE_URL', 'STRIPE_KEY', 'JWT_SECRET', 'AWS_SECRET_ACCESS_KEY'];
      const envCount = 1 + Math.floor(rng() * keys.length);
      for (let k = 0; k < envCount; k++) {
        const secret = `sk_live_${randomToken(rng, 24)}`;
        env[keys[k]!] = secret;
        secrets.push(secret);
      }

      const config = validateApp({
        name: `app-${seed}-${i}`,
        script: '/srv/app/index.ts',
        env,
      });
      statuses.push(toAppStatus(managedFrom(config)));
    }

    // Mirror boot.ts wiring exactly.
    const provider: MetricsDataProvider = {
      getPrometheusMetrics: () => '',
      getJsonMetrics: (appName?: string) =>
        appName ? statuses.filter((a) => a.name === appName) : statuses,
      getStatus: () => ({ apps: statuses, uptime: process.uptime(), pid: process.pid }),
    };

    const { server, port } = await startOnFreePort(provider);
    try {
      const paths = ['/api/status', '/api/metrics', `/api/metrics/${statuses[0]!.name}`];
      for (const path of paths) {
        const body = await (await fetch(`http://127.0.0.1:${port}${path}`)).text();
        for (const secret of secrets) {
          if (body.includes(secret)) {
            throw new Error(
              `seed=${seed} path=${path} leaked env secret ${secret}\nbody=${body.slice(0, 600)}`,
            );
          }
        }
        expect(body).not.toContain('sk_live_');
      }
    } finally {
      server.stop();
    }
  }
}, 20000);
