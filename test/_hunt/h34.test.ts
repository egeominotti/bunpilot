import { expect, test } from 'bun:test';
import { parseArgs } from '../../src/cli/index';

// ---------------------------------------------------------------------------
// h34 — `logs -f <app>` / `logs --follow <app>` swallows the app name
//
// src/cli/commands/logs.ts:82 reads `flags.follow || flags.f`, but neither
// `-f`/`--follow` is registered in BOOLEAN_FLAGS (src/cli/index.ts:34-44).
// The unknown-flag branch (src/cli/index.ts:109-121) therefore greedily
// consumes the following token as the flag's *value* and removes it from the
// positional list — so `logsCommand` sees args === [] and requireArg() exits 1.
//
// Invariant: a flag that a command only tests for *presence* must never
// consume a positional argument.
// ---------------------------------------------------------------------------

/** Deterministic 32-bit PRNG (mulberry32). */
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

test('-f / --follow are presence-only flags and do not eat the app name', () => {
  const dash = parseArgs(['bun', 'bunpilot', 'logs', '-f', 'web']);
  expect(dash.command).toBe('logs');
  expect(dash.args).toEqual(['web']);
  expect(dash.flags.f ?? dash.flags.follow).toBe(true);

  const long = parseArgs(['bun', 'bunpilot', 'logs', '--follow', 'web']);
  expect(long.command).toBe('logs');
  expect(long.args).toEqual(['web']);
  expect(long.flags.follow ?? long.flags.f).toBe(true);
});

test('property: follow flag position never changes the parsed positionals', () => {
  const followTokens = ['-f', '--follow'];
  const appNames = ['web', 'api', 'worker-1', 'my.app', 'svc_2'];
  // Extra flags that ARE registered, to make the sequences realistic.
  const otherFlags: string[][] = [[], ['--json'], ['--lines', '20'], ['--json', '--lines', '5']];

  for (let seed = 1; seed <= 400; seed++) {
    const rand = makeRng(seed);
    const follow = followTokens[Math.floor(rand() * followTokens.length)];
    const app = appNames[Math.floor(rand() * appNames.length)];
    const extras = otherFlags[Math.floor(rand() * otherFlags.length)];

    // Randomly place the follow flag before or after the app name.
    const before = rand() < 0.5;
    const tokens = before ? [follow, app, ...extras] : [app, ...extras, follow];
    const argv = ['bun', 'bunpilot', 'logs', ...tokens];

    const parsed = parseArgs(argv);
    const ctx = `seed=${seed} argv=${JSON.stringify(argv.slice(2))} parsed=${JSON.stringify(parsed)}`;

    expect(parsed.command, ctx).toBe('logs');
    // The app name must survive as a positional regardless of flag ordering.
    expect(parsed.args, ctx).toEqual([app]);
    // logs.ts only checks presence, so the flag must be boolean `true`.
    const followValue = parsed.flags.follow ?? parsed.flags.f;
    expect(followValue, ctx).toBe(true);
  }
});
