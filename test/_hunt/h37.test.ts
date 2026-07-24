// ---------------------------------------------------------------------------
// h37 – ProxyCluster retired worker slots must not accumulate across reloads
// ---------------------------------------------------------------------------
//
// Invariant under test (CL-06):
//   `workers` and `sortedWorkerIds` are bounded by the number of *concurrently
//   configured* workers, not by the number of worker ids ever created.
//
// Real-world shape: `MasterOrchestrator.reload` allocates a fresh monotonic id
// per replacement (`const newId = managed.nextWorkerId++`), calls
// `proxy.addWorker(newId, ...)` for the replacement and `proxy.removeWorker(oldId)`
// for the drained worker. `removeWorker` only flips `alive = false`, and
// `rebuildSortedWorkerIds()` re-derives from `workers.keys()`, so retired ids
// are never reclaimed. `retireWorker()` never touches the proxy. Only `stop()`
// clears the map — i.e. only a full daemon/app stop.
//
// Deterministic seeded operation sequence; the failing seed is printed.
// ---------------------------------------------------------------------------

import { afterEach, expect, test } from 'bun:test';
import { ProxyCluster } from '../../src/cluster/proxy';
import { INTERNAL_PORT_BASE } from '../../src/constants';

// --- seeded PRNG (mulberry32) ---------------------------------------------

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

interface Internals {
  workers: Map<number, { port: number; alive: boolean }>;
  sortedWorkerIds: number[];
  nextAliveWorker: () => { port: number; alive: boolean } | null;
}

function internals(proxy: ProxyCluster): Internals {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = proxy as any;
  return {
    get workers() {
      return p.workers as Map<number, { port: number; alive: boolean }>;
    },
    get sortedWorkerIds() {
      return p.sortedWorkerIds as number[];
    },
    nextAliveWorker: () => p.nextAliveWorker.call(proxy),
  };
}

const openProxies: ProxyCluster[] = [];

afterEach(() => {
  while (openProxies.length > 0) {
    const proxy = openProxies.pop();
    try {
      proxy?.stop();
    } catch {
      /* already stopped */
    }
  }
});

// ---------------------------------------------------------------------------

test('retired worker slots do not accumulate across rolling reloads', () => {
  const SEED = 0xc0ffee;
  const rand = mulberry32(SEED);
  const INSTANCES = 4;
  const RELOADS = 200;

  const proxy = new ProxyCluster();
  openProxies.push(proxy);

  // port 0 -> ephemeral public port, no fixed-port collisions.
  proxy.start(0, INSTANCES);

  const inner = internals(proxy);

  // Reference model: the ids the orchestrator currently considers configured.
  let liveIds = new Set<number>();
  for (let i = 0; i < INSTANCES; i++) {
    proxy.addWorker(i, INTERNAL_PORT_BASE + i);
    liveIds.add(i);
  }

  let nextWorkerId = INSTANCES; // mirrors managed.nextWorkerId

  const check = (step: string): void => {
    expect(
      { step, seed: SEED.toString(16), workers: inner.workers.size },
      `seed=0x${SEED.toString(16)} step=${step}`,
    ).toEqual({ step, seed: SEED.toString(16), workers: liveIds.size });
    expect(
      { step, sorted: inner.sortedWorkerIds.length },
      `seed=0x${SEED.toString(16)} step=${step}`,
    ).toEqual({ step, sorted: liveIds.size });
  };

  check('initial');

  for (let r = 0; r < RELOADS; r++) {
    // Rolling reload: batches of old workers are replaced one group at a time.
    const ordered = [...liveIds].sort((a, b) => a - b);
    const batchSize = 1 + Math.floor(rand() * ordered.length);
    const nextLive = new Set(liveIds);

    for (let b = 0; b < ordered.length; b += batchSize) {
      const batch = ordered.slice(b, b + batchSize);

      // spawnAndTrack: fresh monotonic ids, replacement joins the proxy first
      const replacements: number[] = [];
      for (const _old of batch) {
        const newId = nextWorkerId++;
        proxy.addWorker(newId, INTERNAL_PORT_BASE + newId);
        replacements.push(newId);
        nextLive.add(newId);
      }

      // drainAndStop: old worker leaves the proxy, then is retired by master
      for (const oldId of batch) {
        proxy.removeWorker(oldId);
        nextLive.delete(oldId);
      }

      liveIds = nextLive;
      check(`reload=${r} batch@${b}`);

      // Routing must still only ever hand out live, alive workers.
      const picked = inner.nextAliveWorker();
      expect(picked, `seed=0x${SEED.toString(16)} reload=${r}`).not.toBeNull();
      expect(picked?.alive, `seed=0x${SEED.toString(16)} reload=${r}`).toBe(true);
      expect(
        replacements.length >= 0 && [...liveIds].some((id) => inner.workers.get(id) === picked),
        `seed=0x${SEED.toString(16)} reload=${r}: proxy routed to a retired slot`,
      ).toBe(true);
    }
  }

  // Final hard bound: 200 reloads of a 4-instance app must not leave the
  // master holding hundreds of dead slots.
  expect(inner.workers.size).toBe(INSTANCES);
  expect(inner.sortedWorkerIds.length).toBe(INSTANCES);
});
