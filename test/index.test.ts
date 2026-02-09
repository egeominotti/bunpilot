// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Main Entry Point (src/index.ts)
// ---------------------------------------------------------------------------
//
// Tests showHelp(), showVersion(), and the main() command router by spawning
// the entry point as a subprocess with controlled argv. This avoids mocking
// Bun-native APIs and tests real behavior end-to-end.
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENTRY = resolve(import.meta.dir, '../src/index.ts');

/**
 * Run the CLI entry point with the given arguments and return stdout, stderr,
 * and exit code.
 */
async function runCLI(
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'run', ENTRY, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: undefined },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  return { stdout, stderr, exitCode };
}

/**
 * Strip ANSI escape codes so assertions work against plain text.
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------------------------------------------------------------------------
// showHelp()
// ---------------------------------------------------------------------------

describe('showHelp', () => {
  test('is displayed when no command is given', async () => {
    const { stdout, exitCode } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(exitCode).toBe(0);
    expect(plain).toContain('bunpilot');
    expect(plain).toContain('Bun-native process manager');
  });

  test('contains Usage section', async () => {
    const { stdout } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(plain).toContain('Usage:');
    expect(plain).toContain('bunpilot <command> [args] [flags]');
  });

  test('contains Process Commands section', async () => {
    const { stdout } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(plain).toContain('Process Commands:');
    expect(plain).toContain('start');
    expect(plain).toContain('stop');
    expect(plain).toContain('restart');
    expect(plain).toContain('reload');
    expect(plain).toContain('delete');
  });

  test('contains Inspection Commands section', async () => {
    const { stdout } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(plain).toContain('Inspection Commands:');
    expect(plain).toContain('list');
    expect(plain).toContain('status');
    expect(plain).toContain('logs');
    expect(plain).toContain('metrics');
  });

  test('contains Daemon Commands section', async () => {
    const { stdout } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(plain).toContain('Daemon Commands:');
    expect(plain).toContain('daemon');
    expect(plain).toContain('ping');
  });

  test('contains Other section with init', async () => {
    const { stdout } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(plain).toContain('Other:');
    expect(plain).toContain('init');
  });

  test('contains Global Flags section', async () => {
    const { stdout } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(plain).toContain('Global Flags:');
    expect(plain).toContain('--help');
    expect(plain).toContain('--version');
    expect(plain).toContain('--json');
    expect(plain).toContain('--force');
  });

  test('lists command aliases', async () => {
    const { stdout } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(plain).toContain('aliases:');
    expect(plain).toContain('del');
    expect(plain).toContain('ls');
    expect(plain).toContain('info');
    expect(plain).toContain('log');
    expect(plain).toContain('monit');
  });

  test('is displayed when --help flag is passed (no command)', async () => {
    // --help with no command means flags.help is true and command is '',
    // but looking at main(), the '' case only checks flags.version.
    // --help alone should still show help (the else branch).
    const { stdout, exitCode } = await runCLI(['--help']);
    const plain = stripAnsi(stdout);

    // The current code: when command is '' and flags.version is falsy,
    // it calls showHelp(). So --help still shows help.
    expect(exitCode).toBe(0);
    expect(plain).toContain('bunpilot');
    expect(plain).toContain('Usage:');
  });

  test('help text includes short flag aliases -h and -v', async () => {
    const { stdout } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(plain).toContain('-h');
    expect(plain).toContain('-v');
  });
});

// ---------------------------------------------------------------------------
// showVersion()
// ---------------------------------------------------------------------------

describe('showVersion', () => {
  test('displays version when --version flag is given', async () => {
    const { stdout, exitCode } = await runCLI(['--version']);
    const plain = stripAnsi(stdout).trim();

    expect(exitCode).toBe(0);
    expect(plain).toMatch(/^bunpilot v\d+\.\d+\.\d+$/);
  });

  test('displays version when -v flag is given', async () => {
    const { stdout, exitCode } = await runCLI(['-v']);
    const plain = stripAnsi(stdout).trim();

    expect(exitCode).toBe(0);
    expect(plain).toMatch(/^bunpilot v\d+\.\d+\.\d+$/);
  });

  test('version string contains the correct version', async () => {
    const { stdout } = await runCLI(['--version']);
    const plain = stripAnsi(stdout).trim();

    expect(plain).toBe('bunpilot v0.2.1');
  });

  test('--version takes precedence over help when command is empty', async () => {
    // When command is '' and flags.version is true, showVersion() is called.
    const { stdout } = await runCLI(['--version']);
    const plain = stripAnsi(stdout).trim();

    // Should show version, not help text
    expect(plain).not.toContain('Usage:');
    expect(plain).toContain('bunpilot v');
  });
});

// ---------------------------------------------------------------------------
// main() – Command Router
// ---------------------------------------------------------------------------

describe('main – command routing', () => {
  // ---- Unknown command ----

  test('unknown command prints error and shows help', async () => {
    const { stderr, stdout, exitCode } = await runCLI(['nonexistent']);
    const plainErr = stripAnsi(stderr);
    const plainOut = stripAnsi(stdout);

    expect(exitCode).toBe(1);
    expect(plainErr).toContain('ERROR');
    expect(plainErr).toContain('Unknown command: "nonexistent"');
    expect(plainOut).toContain('Usage:');
  });

  test('unknown command exits with code 1', async () => {
    const { exitCode } = await runCLI(['foobar']);
    expect(exitCode).toBe(1);
  });

  // ---- Command alias routing ----
  // These test that the router recognizes aliases. We can't fully run
  // commands like 'start' without a daemon, but we can verify that the
  // router does NOT fall through to the unknown-command handler.

  test('delete and del are treated as the same command', async () => {
    // Both should route to deleteCommand (not "unknown command").
    // They will fail because no target is given, but the error should NOT
    // be "Unknown command".
    const { stderr: stderr1 } = await runCLI(['delete']);
    const { stderr: stderr2 } = await runCLI(['del']);

    const plain1 = stripAnsi(stderr1);
    const plain2 = stripAnsi(stderr2);

    expect(plain1).not.toContain('Unknown command');
    expect(plain2).not.toContain('Unknown command');
  });

  test('list and ls are treated as the same command', async () => {
    const { stderr: stderr1 } = await runCLI(['list']);
    const { stderr: stderr2 } = await runCLI(['ls']);

    const plain1 = stripAnsi(stderr1);
    const plain2 = stripAnsi(stderr2);

    expect(plain1).not.toContain('Unknown command');
    expect(plain2).not.toContain('Unknown command');
  });

  test('status and info are treated as the same command', async () => {
    const { stderr: stderr1 } = await runCLI(['status']);
    const { stderr: stderr2 } = await runCLI(['info']);

    const plain1 = stripAnsi(stderr1);
    const plain2 = stripAnsi(stderr2);

    expect(plain1).not.toContain('Unknown command');
    expect(plain2).not.toContain('Unknown command');
  });

  test('logs and log are treated as the same command', async () => {
    const { stderr: stderr1 } = await runCLI(['logs']);
    const { stderr: stderr2 } = await runCLI(['log']);

    const plain1 = stripAnsi(stderr1);
    const plain2 = stripAnsi(stderr2);

    expect(plain1).not.toContain('Unknown command');
    expect(plain2).not.toContain('Unknown command');
  });

  test('metrics and monit are treated as the same command', async () => {
    const { stderr: stderr1 } = await runCLI(['metrics']);
    const { stderr: stderr2 } = await runCLI(['monit']);

    const plain1 = stripAnsi(stderr1);
    const plain2 = stripAnsi(stderr2);

    expect(plain1).not.toContain('Unknown command');
    expect(plain2).not.toContain('Unknown command');
  });

  // ---- Known commands reach their handlers (not unknown) ----

  test('start command is recognized', async () => {
    const { stderr } = await runCLI(['start']);
    const plain = stripAnsi(stderr);
    expect(plain).not.toContain('Unknown command');
  });

  test('stop command is recognized', async () => {
    const { stderr } = await runCLI(['stop']);
    const plain = stripAnsi(stderr);
    expect(plain).not.toContain('Unknown command');
  });

  test('restart command is recognized', async () => {
    const { stderr } = await runCLI(['restart']);
    const plain = stripAnsi(stderr);
    expect(plain).not.toContain('Unknown command');
  });

  test('reload command is recognized', async () => {
    const { stderr } = await runCLI(['reload']);
    const plain = stripAnsi(stderr);
    expect(plain).not.toContain('Unknown command');
  });

  test('daemon command is recognized', async () => {
    const { stderr } = await runCLI(['daemon']);
    const plain = stripAnsi(stderr);
    expect(plain).not.toContain('Unknown command');
  });

  test('ping command is recognized', async () => {
    const { stderr } = await runCLI(['ping']);
    const plain = stripAnsi(stderr);
    expect(plain).not.toContain('Unknown command');
  });

  test('init command is recognized', async () => {
    // init may succeed or fail depending on whether a config already exists,
    // but it should never say "Unknown command".
    const { stderr } = await runCLI(['init']);
    const plain = stripAnsi(stderr);
    expect(plain).not.toContain('Unknown command');
  });

  // ---- Edge cases ----

  test('empty argv shows help', async () => {
    const { stdout, exitCode } = await runCLI([]);
    const plain = stripAnsi(stdout);

    expect(exitCode).toBe(0);
    expect(plain).toContain('Usage:');
  });

  test('only flags and no command shows help or version', async () => {
    // --json alone: command is '' and flags.version is falsy, so showHelp()
    const { stdout } = await runCLI(['--json']);
    const plain = stripAnsi(stdout);
    expect(plain).toContain('Usage:');
  });

  test('command with multiple unknown flags does not crash', async () => {
    const { stderr } = await runCLI(['start', '--unknown1', '--unknown2', 'val']);
    const plain = stripAnsi(stderr);
    expect(plain).not.toContain('Unknown command');
  });
});

// ---------------------------------------------------------------------------
// ANSI constants (indirectly tested via output)
// ---------------------------------------------------------------------------

describe('ANSI formatting in output', () => {
  test('help output contains ANSI escape codes (not stripped)', async () => {
    const { stdout } = await runCLI([]);

    // The raw output should contain ANSI bold/green/reset sequences
    expect(stdout).toContain('\x1b[1m'); // BOLD
    expect(stdout).toContain('\x1b[32m'); // GREEN
    expect(stdout).toContain('\x1b[0m'); // RESET
  });

  test('version output does not contain ANSI codes', async () => {
    const { stdout } = await runCLI(['--version']);

    // showVersion() outputs plain text without ANSI codes
    expect(stdout.trim()).not.toContain('\x1b[');
  });
});
