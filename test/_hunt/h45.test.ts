// ---------------------------------------------------------------------------
// h45 — INV-CLI-02: a flag listed in BOOLEAN_FLAGS must never carry a string
// value. `--force=false` / `--json=false` / `--help=0` are parsed by the
// `--flag=value` branch (src/cli/index.ts:71) which never consults
// BOOLEAN_FLAGS, so the flag lands in `flags` as a raw (truthy) string.
// ---------------------------------------------------------------------------

import { afterAll, expect, mock, test } from 'bun:test';

import * as connectNamespace from '../../src/cli/commands/_connect';
import { parseArgs } from '../../src/cli/index';

// Snapshot the REAL `_connect` exports by value at module-eval time (a module
// namespace is a live binding, so `mock.module` would otherwise rewrite even a
// captured reference). `mock.module` overrides persist for the whole process
// and `mock.restore()` does not revert them, so re-install the snapshot after
// this file to avoid leaking the stub into other files that run in the same bun
// process (e.g. h27).
const realConnect = { ...connectNamespace };
afterAll(() => {
  mock.module('../../src/cli/commands/_connect', () => realConnect);
});

// ---------------------------------------------------------------------------
// Seeded deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

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

/** token -> canonical flag name, mirroring BOOLEAN_FLAGS in src/cli/index.ts */
const BOOLEAN_TOKENS: Array<[string, string]> = [
  ['--daemon', 'daemon'],
  ['--no-daemon', 'no-daemon'],
  ['--force', 'force'],
  ['--json', 'json'],
  ['--prometheus', 'prometheus'],
  ['--help', 'help'],
  ['--version', 'version'],
];

const VALUES = ['false', 'true', '0', '1', 'no', 'yes', '', 'off'];
const COMMANDS = ['delete', 'restart', 'list', 'metrics', 'stop', 'logs'];

// ---------------------------------------------------------------------------
// 1. Property: boolean flags never carry a string, whatever the syntax
// ---------------------------------------------------------------------------

test('INV-CLI-02: boolean flags are never parsed into a string value', () => {
  const rng = makeRng(0xb0016a11);

  for (let iter = 0; iter < 500; iter++) {
    const seed = iter;
    const [token, name] = BOOLEAN_TOKENS[Math.floor(rng() * BOOLEAN_TOKENS.length)]!;
    const value = VALUES[Math.floor(rng() * VALUES.length)]!;
    const command = COMMANDS[Math.floor(rng() * COMMANDS.length)]!;

    const argv = ['bun', 'bp', command, 'myapp', `${token}=${value}`];
    const parsed = parseArgs(argv);
    const got = parsed.flags[name];

    if (typeof got !== 'boolean') {
      throw new Error(
        `INV-CLI-02 violated (seed=${seed}): argv=${JSON.stringify(argv)} ` +
          `-> flags.${name} = ${JSON.stringify(got)} (typeof ${typeof got}); ` +
          `boolean flags must never be a string`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Concrete consequence A: `--force=false` bypasses the delete prompt
//    (delete.ts tests `if (!flags.force)`; 'false' is truthy → no prompt)
// ---------------------------------------------------------------------------

test('--force=false must not read as "force" for the delete confirmation gate', () => {
  const flags = parseArgs(['bun', 'bp', 'delete', 'myapp', '--force=false']).flags;
  // delete.ts:25 / :48 gate on `!flags.force`
  const promptShown = !flags.force;
  expect(promptShown).toBe(true);
});

// ---------------------------------------------------------------------------
// 3. Concrete consequence B: `--force=true` silently degrades a forced restart
// ---------------------------------------------------------------------------

test('--force=true reaches the daemon as force:true', async () => {
  const sent: Array<{ cmd: string; payload: unknown }> = [];

  mock.module('../../src/cli/commands/_connect', () => ({
    sendCommand: async (cmd: string, payload?: unknown) => {
      sent.push({ cmd, payload });
      return { success: true, data: [] };
    },
    sendStreamCommand: async () => {},
    requireArg: (args: string[], label: string) => {
      const v = args[0];
      if (v === undefined) throw new Error(`missing ${label}`);
      return v;
    },
  }));

  const { restartCommand } = await import('../../src/cli/commands/restart');
  const flags = parseArgs(['bun', 'bp', 'restart', 'myapp', '--force=true']).flags;

  await restartCommand(['myapp'], flags);

  expect(sent).toHaveLength(1);
  expect(sent[0]!.payload).toEqual({ name: 'myapp', force: true });
});
