// H56 — the SDK's signal-driven shutdown budget must follow the operator's
// configured killTimeout, not a hard-coded 5 s.
//
// Production path exercised here is exactly the one worker-handler.ts uses:
//   ProcessManager.spawnWorker(config, ...)   -> builds the worker env
//   ProcessManager.killWorker(pid, config.shutdownSignal, config.killTimeout)
//
// With `killTimeout` well above 5 s, a worker whose `bunpilotOnShutdown`
// handler needs `drainMs` (< killTimeout) must be allowed to finish draining.

import { afterAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../../src/config/types';
import { APP_DEFAULTS } from '../../src/constants';
import { ProcessManager } from '../../src/core/process-manager';
import { makeTempDir } from '../_helpers/tmp';

const SDK_PATH = join(import.meta.dir, '..', '..', 'src', 'sdk', 'worker.ts');

const dir = makeTempDir('h56-');
const spawnedPids: number[] = [];

afterAll(() => {
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Deterministic 32-bit PRNG so a failure is always reproducible from SEED. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed_56;

function baseConfig(script: string, killTimeout: number): AppConfig {
  return {
    ...APP_DEFAULTS,
    name: 'h56-app',
    script,
    instances: 1,
    killTimeout,
    backoff: { initial: 100, multiplier: 2, max: 1_000 },
    cwd: dir,
  };
}

test('SDK graceful drain is bounded by the configured killTimeout, not a hard-coded 5s', async () => {
  const rand = mulberry32(SEED);
  // killTimeout comfortably above the SDK's hard-coded 5_000 ms budget and
  // within the validator's accepted range (1_000..120_000).
  const killTimeout = 8_000 + Math.floor(rand() * 3) * 1_000; // 8000 | 9000 | 10000
  // Drain time strictly between the hard-coded 5 s and the operator's budget.
  const drainMs = 6_500;

  console.log(`[h56] SEED=${SEED} killTimeout=${killTimeout} drainMs=${drainMs}`);
  expect(drainMs).toBeGreaterThan(5_000);
  expect(drainMs).toBeLessThan(killTimeout);

  const marker = join(dir, 'drain-complete');
  const script = join(dir, 'worker.ts');
  await Bun.write(
    script,
    [
      `import { bunpilotOnShutdown } from ${JSON.stringify(SDK_PATH)};`,
      `const marker = ${JSON.stringify(marker)};`,
      `const drainMs = ${drainMs};`,
      'bunpilotOnShutdown(async () => {',
      '  await Bun.sleep(drainMs);',
      "  await Bun.write(marker, '1');",
      '});',
      'const keepAlive = setInterval(() => {}, 1_000);',
      'void keepAlive;',
      "process.send?.({ type: 'ready' });",
      '',
    ].join('\n'),
  );

  const pm = new ProcessManager();
  const config = baseConfig(script, killTimeout);
  const spawned = pm.spawnWorker(
    config,
    0,
    () => {},
    () => {},
  );
  spawnedPids.push(spawned.pid);

  // Wait until the child is up and its signal handler is installed.
  const upDeadline = Date.now() + 5_000;
  while (Date.now() < upDeadline && !pm.isRunning(spawned.pid)) {
    await Bun.sleep(25);
  }
  await Bun.sleep(400);
  expect(pm.isRunning(spawned.pid)).toBe(true);

  const t0 = Date.now();
  const outcome = await pm.killWorker(spawned.pid, config.shutdownSignal, config.killTimeout);
  const elapsed = Date.now() - t0;

  const drained = await Bun.file(marker).exists();
  console.log(`[h56] outcome=${outcome} elapsedMs=${elapsed} drainComplete=${drained}`);

  // The invariant: with killTimeout=${killTimeout} the operator granted the
  // worker enough room to finish a ${drainMs} ms drain. It must not be cut
  // short at the SDK's hard-coded 5 s.
  expect(drained).toBe(true);
  expect(elapsed).toBeGreaterThanOrEqual(drainMs - 500);
  expect(outcome).toBe('exited');
}, 25_000);
