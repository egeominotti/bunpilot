import { expect, test } from 'bun:test';

import { parseArgs } from '../../src/cli/index';

// ---------------------------------------------------------------------------
// h35 — `-f` / `--follow` are not registered flags, so `logs -f <app>` loses
//       the app name.
//
// src/cli/commands/logs.ts:82 gates follow-mode on `flags.follow || flags.f`,
// but neither token appears in BOOLEAN_FLAGS (src/cli/index.ts:34-44) nor in
// VALUE_FLAGS (:20-31). The unknown-flag branch (src/cli/index.ts:109-121)
// therefore treats the next non-dash token as the flag's *value* and drops it
// from the positional list — so `bunpilot logs -f myapp` reaches
// logsCommand() with args === [] and dies in requireArg().
//
// Invariant: a flag a command tests for *presence* must parse as a boolean and
// must never consume a positional argument, regardless of where the user puts
// it on the command line.
// ---------------------------------------------------------------------------

/** Deterministic 32-bit PRNG (mulberry32) so failures are reproducible. */
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

test('logs -f <app> keeps the app name and sets follow to true', () => {
  const parsed = parseArgs(['bun', 'bunpilot', 'logs', '-f', 'myapp']);

  expect(parsed.command).toBe('logs');
  expect(parsed.args).toEqual(['myapp']);
  expect(parsed.flags.f ?? parsed.flags.follow).toBe(true);
});

test('logs --follow <app> keeps the app name and sets follow to true', () => {
  const parsed = parseArgs(['bun', 'bunpilot', 'logs', '--follow', 'myapp']);

  expect(parsed.command).toBe('logs');
  expect(parsed.args).toEqual(['myapp']);
  expect(parsed.flags.follow ?? parsed.flags.f).toBe(true);
});

test('property: follow-flag placement never changes what logsCommand receives', () => {
  const FOLLOW_TOKENS = ['-f', '--follow'];
  const APP_NAMES = ['api', 'web', 'worker', 'my-app', 'queue_1'];
  // Extra tokens that are all *properly registered*, so they are not the
  // source of any positional loss.
  const EXTRA_TOKENS: string[][] = [
    [],
    ['--json'],
    ['--lines', '20'],
    ['--lines=20'],
    ['--json', '--lines', '5'],
  ];

  const failures: string[] = [];

  for (let seed = 1; seed <= 300; seed++) {
    const rand = makeRng(seed);
    const follow = FOLLOW_TOKENS[Math.floor(rand() * FOLLOW_TOKENS.length)]!;
    const app = APP_NAMES[Math.floor(rand() * APP_NAMES.length)]!;
    const extras = EXTRA_TOKENS[Math.floor(rand() * EXTRA_TOKENS.length)]!;

    // Position the follow flag either before or after the app name.
    const followFirst = rand() < 0.5;
    const tail = followFirst ? [follow, app, ...extras] : [app, ...extras, follow];
    const argv = ['bun', 'bunpilot', 'logs', ...tail];

    const parsed = parseArgs(argv);
    const followValue = parsed.flags.follow ?? parsed.flags.f;

    if (parsed.command !== 'logs') {
      failures.push(`seed=${seed} argv=${JSON.stringify(tail)} command=${parsed.command}`);
      continue;
    }
    // The app name must survive as a positional so requireArg() can find it.
    if (parsed.args[0] !== app) {
      failures.push(
        `seed=${seed} argv=${JSON.stringify(tail)} expected args[0]=${app} got args=${JSON.stringify(parsed.args)} flags=${JSON.stringify(parsed.flags)}`,
      );
      continue;
    }
    // And the follow flag must be a real boolean, not a coerced string.
    if (followValue !== true) {
      failures.push(
        `seed=${seed} argv=${JSON.stringify(tail)} expected follow=true got ${JSON.stringify(followValue)}`,
      );
    }
  }

  expect(failures.slice(0, 5).join('\n')).toBe('');
});
