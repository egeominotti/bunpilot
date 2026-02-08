// ---------------------------------------------------------------------------
// bunpm2 – Unit Tests for CLI Argument Parser
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { parseArgs, extractEnv } from '../../src/cli/index';

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('parses a basic command', () => {
    const result = parseArgs(['bun', 'script', 'start', 'app.ts']);
    expect(result.command).toBe('start');
    expect(result.args).toEqual(['app.ts']);
    expect(result.flags).toEqual({});
  });

  test('parses named value flags', () => {
    const result = parseArgs(['bun', 'script', 'start', '--name', 'myapp']);
    expect(result.command).toBe('start');
    expect(result.flags.name).toBe('myapp');
  });

  test('parses boolean flags', () => {
    const result = parseArgs(['bun', 'script', 'list', '--json']);
    expect(result.command).toBe('list');
    expect(result.flags.json).toBe(true);
  });

  test('parses --flag=value syntax', () => {
    const result = parseArgs(['bun', 'script', 'start', '--name=myapp']);
    expect(result.flags.name).toBe('myapp');
  });

  test('parses short flags', () => {
    const result = parseArgs(['bun', 'script', 'start', '-n', 'myapp', '-i', '4']);
    expect(result.flags.name).toBe('myapp');
    expect(result.flags.instances).toBe('4');
  });

  test('parses multiple positional args', () => {
    const result = parseArgs(['bun', 'script', 'restart', 'web', 'worker']);
    expect(result.command).toBe('restart');
    expect(result.args).toEqual(['web', 'worker']);
  });

  test('returns empty command when none given', () => {
    const result = parseArgs(['bun', 'script']);
    expect(result.command).toBe('');
    expect(result.args).toEqual([]);
  });

  test('handles --env flag collecting KEY=VALUE pairs', () => {
    const result = parseArgs([
      'bun',
      'script',
      'start',
      'app.ts',
      '--env',
      'NODE_ENV=production',
      '--env',
      'PORT=3000',
    ]);
    expect(result.command).toBe('start');
    expect(result.flags._env).toBeDefined();

    const envParsed = JSON.parse(result.flags._env as string);
    expect(envParsed.NODE_ENV).toBe('production');
    expect(envParsed.PORT).toBe('3000');
  });

  test('handles mixed flags, boolean flags, and positional args', () => {
    const result = parseArgs([
      'bun',
      'script',
      'start',
      'app.ts',
      '--name',
      'myapp',
      '--json',
      '-i',
      '2',
    ]);
    expect(result.command).toBe('start');
    expect(result.args).toEqual(['app.ts']);
    expect(result.flags.name).toBe('myapp');
    expect(result.flags.json).toBe(true);
    expect(result.flags.instances).toBe('2');
  });

  test('handles --daemon boolean flag', () => {
    const result = parseArgs(['bun', 'script', 'start', '--daemon']);
    expect(result.flags.daemon).toBe(true);
  });

  test('handles --help and -h', () => {
    const r1 = parseArgs(['bun', 'script', '--help']);
    expect(r1.flags.help).toBe(true);

    const r2 = parseArgs(['bun', 'script', '-h']);
    expect(r2.flags.help).toBe(true);
  });

  test('handles --version and -v', () => {
    const r1 = parseArgs(['bun', 'script', '--version']);
    expect(r1.flags.version).toBe(true);

    const r2 = parseArgs(['bun', 'script', '-v']);
    expect(r2.flags.version).toBe(true);
  });

  test('handles --port / -p', () => {
    const result = parseArgs(['bun', 'script', 'start', '-p', '8080']);
    expect(result.flags.port).toBe('8080');
  });

  test('handles unknown flags gracefully', () => {
    const result = parseArgs(['bun', 'script', 'start', '--custom', 'val']);
    expect(result.flags.custom).toBe('val');
  });

  test('handles unknown boolean-style flags', () => {
    const result = parseArgs(['bun', 'script', 'start', '--verbose']);
    expect(result.flags.verbose).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractEnv
// ---------------------------------------------------------------------------

describe('extractEnv', () => {
  test('returns parsed env vars from _env flag', () => {
    const flags = { _env: JSON.stringify({ NODE_ENV: 'test', PORT: '3000' }) };
    const env = extractEnv(flags);
    expect(env).toEqual({ NODE_ENV: 'test', PORT: '3000' });
  });

  test('returns undefined when no _env flag exists', () => {
    expect(extractEnv({})).toBeUndefined();
    expect(extractEnv({ name: 'app' })).toBeUndefined();
  });

  test('returns undefined when _env is not a string', () => {
    expect(extractEnv({ _env: true })).toBeUndefined();
    expect(extractEnv({ _env: 42 as unknown as string })).toBeUndefined();
  });

  test('returns undefined for empty env object', () => {
    expect(extractEnv({ _env: '{}' })).toBeUndefined();
  });

  test('integrates with parseArgs for --env flags', () => {
    const parsed = parseArgs([
      'bun',
      'script',
      'start',
      '--env',
      'DB_HOST=localhost',
      '--env',
      'DB_PORT=5432',
    ]);
    const env = extractEnv(parsed.flags);
    expect(env).toEqual({ DB_HOST: 'localhost', DB_PORT: '5432' });
  });
});
