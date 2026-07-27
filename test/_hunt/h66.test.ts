// ---------------------------------------------------------------------------
// h66 – metrics.enabled:false is ignored by the daemon
// ---------------------------------------------------------------------------
//
// Invariant under test:
//   When every app in the config sets `metrics.enabled: false`, the daemon
//   must NOT acquire the metrics TCP port, and that port must stay available
//   for user apps.
//
// Two independent proofs:
//   1. Integration: bootDaemon() still constructs + start()s MetricsHttpServer
//      (src/daemon/boot.ts:162/203) with no gate on `metrics.enabled`, so the
//      unauthenticated /api/status endpoint is live and the socket is bound.
//   2. Unit/property: because the daemon unconditionally claims the metrics
//      port, validateConfig() refuses any app that wants to listen on it —
//      even when metrics are disabled everywhere.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig } from '../../src/config/validator';
import { DEFAULT_METRICS } from '../../src/constants';
import { makeTempDir } from '../_helpers/tmp';

const SRC_ROOT = join(import.meta.dir, '..', '..', 'src');

const cleanups: Array<() => void> = [];
afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

/** Grab a free high port by binding :0 and immediately releasing it. */
function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') });
  // `Server.port` is optional in the types (unix-socket servers have none);
  // a TCP listener on :0 always reports the kernel-assigned port.
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error('Bun.serve did not report a listening port');
  return port;
}

// ---------------------------------------------------------------------------
// Proof 1 – the daemon binds the metrics port even with metrics disabled
// ---------------------------------------------------------------------------

test('daemon does not bind the metrics port when every app disables metrics', async () => {
  const tmp = makeTempDir('bunpilot-h66-');
  cleanups.push(() => rmSync(tmp, { recursive: true, force: true }));

  const home = join(tmp, 'home');
  const port = freePort();

  // A worker that stays alive but self-terminates so it can never be orphaned.
  writeFileSync(
    join(tmp, 'app.ts'),
    'setTimeout(() => process.exit(0), 15_000);\nsetInterval(() => {}, 1_000);\n',
  );

  // Metrics are explicitly OFF for the only app in the config.
  const cfgPath = join(tmp, 'bunpilot.json');
  writeFileSync(
    cfgPath,
    JSON.stringify({
      apps: [
        {
          name: 'h66-web',
          script: join(tmp, 'app.ts'),
          instances: 1,
          metrics: { enabled: false },
          healthCheck: { enabled: false },
        },
      ],
    }),
  );

  // Driver: retarget the *default* metrics port onto an ephemeral port so the
  // test never fights the machine over the hard-coded 9615, then boot.
  const driverPath = join(tmp, 'driver.ts');
  writeFileSync(
    driverPath,
    [
      `const { DEFAULT_METRICS } = await import(${JSON.stringify(join(SRC_ROOT, 'constants.ts'))});`,
      `DEFAULT_METRICS.httpPort = ${port};`,
      `const { bootDaemon } = await import(${JSON.stringify(join(SRC_ROOT, 'daemon', 'boot.ts'))});`,
      `await bootDaemon(${JSON.stringify(cfgPath)});`,
      `console.log('H66_BOOTED');`,
    ].join('\n'),
  );

  const proc = Bun.spawn(['bun', 'run', driverPath], {
    cwd: tmp,
    env: { ...process.env, BUNPILOT_HOME: home, BUNPILOT_SOCKET: join(home, 'h66.sock') },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  cleanups.push(() => {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 1_500).unref?.();
  });

  // Wait for the daemon to report readiness (bounded).
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let out = '';
  const deadline = Date.now() + 12_000;
  while (!out.includes('H66_BOOTED') && Date.now() < deadline) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), 500),
      ),
    ]);
    if (chunk.value) out += decoder.decode(chunk.value, { stream: true });
    else if (chunk.done && out.includes('H66_BOOTED')) break;
  }
  reader.releaseLock?.();

  expect(out).toContain('H66_BOOTED'); // sanity: the daemon actually booted

  // THE INVARIANT: metrics are disabled, so nothing may be listening there.
  let reachable = false;
  let body = '';
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      signal: AbortSignal.timeout(3_000),
    });
    reachable = true;
    body = await res.text();
  } catch {
    reachable = false;
  }

  if (reachable) {
    console.error(`[h66] /api/status on disabled metrics port ${port} returned: ${body}`);
  }
  expect(reachable).toBe(false);
}, 20_000);

// ---------------------------------------------------------------------------
// Proof 2 – the reserved metrics port is stolen from user apps (property loop)
// ---------------------------------------------------------------------------

test('a metrics-disabled config may use any public port, including the default metrics port', () => {
  // Deterministic PRNG (mulberry32) so a failure is always reproducible.
  const SEED = 0x9615_2026;
  let state = SEED >>> 0;
  const rnd = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const defaultMetricsPort = DEFAULT_METRICS.httpPort ?? 9_615;

  // Candidate public ports: always include the daemon's default metrics port,
  // plus pseudo-random high ports that must all behave identically.
  const ports: number[] = [defaultMetricsPort];
  for (let i = 0; i < 40; i++) {
    ports.push(1_024 + Math.floor(rnd() * 60_000));
  }

  for (const publicPort of ports) {
    const seedInfo = `seed=0x96152026 publicPort=${publicPort}`;
    let error: unknown = null;
    try {
      validateConfig({
        apps: [
          {
            name: `app-${publicPort}`,
            script: 'server.ts',
            port: publicPort,
            // The user explicitly turned metrics OFF for every app.
            metrics: { enabled: false },
          },
        ],
      });
    } catch (e) {
      error = e;
    }

    if (error) {
      console.error(`[h66] FAILING ${seedInfo}: ${(error as Error).message}`);
    }
    expect({ seedInfo, message: error ? (error as Error).message : null }).toEqual({
      seedInfo,
      message: null,
    });
  }
});
