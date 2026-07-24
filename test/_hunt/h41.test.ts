import { expect, test } from 'bun:test';
import { validateInstances } from '../../src/config/validate-helpers';
import { validateApp } from '../../src/config/validator';
import { INTERNAL_PORT_BASE } from '../../src/constants';

// ---------------------------------------------------------------------------
// h41 — `instances` has no upper bound.
//
// AGENTS.md: "Config, IPC, PID files, app names, and log filenames are
// untrusted input. Reject traversal, NULs, invalid numbers, and unsafe process
// IDs." and "Public and internal ports are globally collision-free".
//
// `validateInstances` (src/config/validate-helpers.ts:129) only asserts a
// positive integer. Nothing caps it against the internal port space
// (INTERNAL_PORT_BASE + instances must stay <= 65535) or against any process
// limit, and `validateApp` itself walks the value once per instance when custom
// log filenames are set (validateLogPathCollisions, validator.ts:131) — so a
// single oversized number both passes validation and blocks the caller.
//
// `validateApp` runs INSIDE the daemon on the control-plane start path
// (src/daemon/boot.ts) and on the SQLite restore path, so both failures land on
// the single-threaded daemon.
// ---------------------------------------------------------------------------

/** Deterministic PRNG (mulberry32) so a failure is reproducible from its seed. */
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

// The absolute ceiling implied by the internal port space: worker N binds
// INTERNAL_PORT_BASE + N, and ports stop at 65535. Any accepted instance count
// above this cannot be served by the runtime under any strategy. This is a
// deliberately generous bound — a real fix would cap far lower.
const PORT_SPACE_CEILING = 65535 - INTERNAL_PORT_BASE + 1; // 25535

test('h41: validated `instances` never exceeds what the runtime can serve', () => {
  const SEEDS = 200;
  const offenders: Array<{ seed: number; input: number; accepted: number | 'max' }> = [];

  for (let seed = 1; seed <= SEEDS; seed++) {
    const rng = makeRng(seed);
    // Draw an integer log-uniformly across 1 .. ~1e9 so the sweep covers both
    // sane counts and absurd ones.
    const exponent = rng() * 9; // 0 .. 9
    const input = Math.max(1, Math.floor(10 ** exponent));

    let accepted: number | 'max';
    try {
      accepted = validateInstances(input, 'app:h41');
    } catch {
      continue; // rejected — this is the desired behaviour for absurd values
    }

    if (accepted !== 'max' && accepted > PORT_SPACE_CEILING) {
      offenders.push({ seed, input, accepted });
    }
  }

  let detail = 'none';
  if (offenders.length > 0) {
    const worst = offenders.reduce((a, b) => (a.accepted > b.accepted ? a : b));
    detail =
      `${offenders.length}/${SEEDS} seeds accepted an unservable count; ` +
      `worst seed=${worst.seed} input=${worst.input} accepted=${String(worst.accepted)}`;
    console.error(`h41: ${detail} (port-space ceiling=${PORT_SPACE_CEILING}).`);
  }

  expect({ unservableAccepted: offenders.length, detail }).toEqual({
    unservableAccepted: 0,
    detail: 'none',
  });
});

test('h41: validateApp terminates in bounded time for an absurd instance count', () => {
  // With custom log filenames, validateLogPathCollisions loops once per
  // instance and inserts two Map entries per iteration, so validateApp's cost
  // is linear in an unvalidated attacker-controlled number.
  const instances = 1_000_000;

  const start = Date.now();
  let outcome: string;
  try {
    validateApp({
      name: 'h41-svc',
      script: 'server.ts',
      instances,
      logs: { outFile: 'out.log', errFile: 'err.log' },
    });
    outcome = 'accepted';
  } catch (err) {
    outcome = `rejected (${(err as Error).message.slice(0, 80)})`;
  }
  const elapsed = Date.now() - start;

  console.error(`h41: validateApp({instances:${instances}}) ${outcome} after ${elapsed}ms`);

  // A bounded validator rejects the value immediately; it must never spend
  // real wall-clock time proportional to the input, because this runs on the
  // daemon's single thread while every other app's timers wait.
  expect(elapsed).toBeLessThan(500);
});
