// ---------------------------------------------------------------------------
// h27 – INV-CLI-10: the literal name "all" is a CLI wildcard sentinel, so no
// managed app may ever be named "all".
//
// Part A (integration) establishes the premise: with a fake daemon on a temp
// unix socket, `delete all --force` fans out over the whole fleet instead of
// targeting the app literally named "all".
//
// Part B (property) is the actual invariant check: config validation must
// refuse to mint an app named "all", through BOTH creation routes
//   (1) explicit --name  -> validateApp({ name: 'all', ... })
//   (2) derived name     -> loadFromCLI({ script: './all.ts' })
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteCommand } from '../../src/cli/commands/delete';
import { loadFromCLI } from '../../src/config/loader';
import { validateApp } from '../../src/config/validator';
import { encodeMessage, NdjsonFramer } from '../../src/control/protocol';

const WILDCARD = 'all';

// ---------------------------------------------------------------------------
// Fake daemon (unix socket under /private/tmp, cleaned up in afterAll)
// ---------------------------------------------------------------------------

const tmpRoot = mkdtempSync(join(tmpdir(), 'bunpilot-h27-'));
const socketPath = join(tmpRoot, 'h27.sock');
const previousSocketEnv = process.env.BUNPILOT_SOCKET;

interface Fleet {
  deleted: string[];
}
const fleet: Fleet = { deleted: [] };
const FLEET_NAMES = ['api', WILDCARD, 'web'];

const server = Bun.listen<{ framer: NdjsonFramer }>({
  unix: socketPath,
  socket: {
    open(socket) {
      socket.data = { framer: new NdjsonFramer() };
    },
    data(socket, raw) {
      for (const msg of socket.data.framer.push(raw)) {
        const req = msg as { id: string; cmd: string; args?: Record<string, unknown> };
        if (req.cmd === 'list') {
          const data = FLEET_NAMES.map((name) => ({ name, status: 'online' }));
          socket.write(encodeMessage({ id: req.id, ok: true, data }));
        } else if (req.cmd === 'delete') {
          fleet.deleted.push(String(req.args?.name));
          socket.write(encodeMessage({ id: req.id, ok: true }));
        } else {
          socket.write(encodeMessage({ id: req.id, ok: true }));
        }
      }
    },
  },
});

afterAll(() => {
  try {
    server.stop(true);
  } catch {
    /* ignore */
  }
  if (previousSocketEnv === undefined) delete process.env.BUNPILOT_SOCKET;
  else process.env.BUNPILOT_SOCKET = previousSocketEnv;
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Part A – premise: "all" really is a fleet-wide wildcard in the CLI
// ---------------------------------------------------------------------------

test('premise: `delete all --force` deletes the whole fleet, not the app named "all"', async () => {
  process.env.BUNPILOT_SOCKET = socketPath;
  fleet.deleted = [];

  await deleteCommand([WILDCARD], { force: true });

  // If "all" were an addressable app name, exactly one delete would be sent.
  expect(fleet.deleted).toEqual(FLEET_NAMES);
  expect(fleet.deleted.length).toBeGreaterThan(1);
});

// ---------------------------------------------------------------------------
// Part B – invariant: validation must never mint an app named "all"
// ---------------------------------------------------------------------------

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

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)] as T;
}

test('INV-CLI-10: no config route may produce an app named "all"', () => {
  const BASE_SEED = 0xa11;
  const DIRS = ['', './', '../', 'src/', '/opt/svc/', './a/b/', 'deep/nested/dir/'];
  const EXTS = ['.ts', '.js', '.mjs', '.tsx', ''];

  // Sanity: ordinary names must still be accepted, so a passing test cannot be
  // achieved by simply rejecting everything.
  for (let i = 0; i < 50; i++) {
    const rng = mulberry32(BASE_SEED + i);
    const ok = `app-${Math.floor(rng() * 1e6)}`;
    expect(validateApp({ name: ok, script: './server.ts' }).name).toBe(ok);
    expect(loadFromCLI({ script: `${pick(rng, DIRS)}svc-${i}${pick(rng, EXTS)}` }).name).toContain(
      'svc-',
    );
  }

  const failures: string[] = [];

  for (let i = 0; i < 200; i++) {
    const seed = BASE_SEED + i;
    const rng = mulberry32(seed);
    const script = `${pick(rng, DIRS)}${WILDCARD}${pick(rng, EXTS)}`;

    // Route 1: explicit --name all
    let threw = false;
    try {
      validateApp({ name: WILDCARD, script });
    } catch {
      threw = true;
    }
    if (!threw) {
      failures.push(
        `seed=${seed} route=explicit-name validateApp({name:"${WILDCARD}"}) was ACCEPTED`,
      );
    }

    // Route 2: name derived from the script path (deriveAppName)
    let derivedName: string | undefined;
    let derivedThrew = false;
    try {
      derivedName = loadFromCLI({ script }).name;
    } catch {
      derivedThrew = true;
    }
    if (!derivedThrew && derivedName === WILDCARD) {
      failures.push(
        `seed=${seed} route=derived loadFromCLI({script:"${script}"}) produced name "${derivedName}"`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `INV-CLI-10 violated: config validation minted the wildcard app name "${WILDCARD}" ` +
        `${failures.length} time(s); such an app is untargetable and makes ` +
        `\`delete all --force\` wipe the entire fleet.\nFirst failures:\n  ${failures
          .slice(0, 4)
          .join('\n  ')}`,
    );
  }
});
