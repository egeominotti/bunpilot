// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Config Validator
// ---------------------------------------------------------------------------

import { describe, expect, test } from 'bun:test';
import { resolveInstances, validateApp, validateConfig } from '../../src/config/validator';

// ---------------------------------------------------------------------------
// resolveInstances
// ---------------------------------------------------------------------------

describe('resolveInstances', () => {
  test('"max" returns a positive number based on CPU count', () => {
    const result = resolveInstances('max');
    expect(typeof result).toBe('number');
    expect(result).toBeGreaterThan(0);
  });

  test('numeric value is returned as-is', () => {
    expect(resolveInstances(4)).toBe(4);
    expect(resolveInstances(1)).toBe(1);
    expect(resolveInstances(16)).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// validateApp
// ---------------------------------------------------------------------------

describe('validateApp', () => {
  test('accepts a valid minimal config', () => {
    const result = validateApp({ name: 'app', script: 'index.ts' });
    expect(result.name).toBe('app');
    expect(result.script).toBe('index.ts');
  });

  test('applies default values for omitted optional fields', () => {
    const result = validateApp({ name: 'app', script: 'index.ts' });

    expect(result.maxRestarts).toBe(15);
    expect(result.killTimeout).toBe(5_000);
    expect(result.shutdownSignal).toBe('SIGTERM');
    expect(result.minUptime).toBe(30_000);
    expect(result.maxRestartWindow).toBe(900_000);
    expect(result.readyTimeout).toBe(30_000);
    expect(result.instances).toBe(1);
    expect(result.healthCheck).toBeDefined();
    expect(result.logs).toBeDefined();
    expect(result.metrics).toBeDefined();
    expect(result.clustering).toBeDefined();
    expect(result.clustering?.enabled).toBe(true);
  });

  test('applies default backoff config', () => {
    const result = validateApp({ name: 'app', script: 'index.ts' });

    expect(result.backoff).toEqual({
      initial: 1_000,
      multiplier: 2,
      max: 30_000,
    });
  });

  test('accepts all optional fields', () => {
    const result = validateApp({
      name: 'full-app',
      script: 'server.ts',
      port: 3000,
      env: { NODE_ENV: 'production' },
      cwd: '/app',
      instances: 4,
      healthCheck: { enabled: true, path: '/healthz', interval: 10_000, timeout: 2_000 },
      logs: {
        outFile: 'archive/out.log',
        errFile: 'archive/err.log',
        maxSize: 5_000_000,
        maxFiles: 3,
      },
      metrics: { enabled: true, prometheus: true, collectInterval: 10_000, httpPort: 9100 },
      clustering: { enabled: true, strategy: 'reusePort' },
    });

    expect(result.port).toBe(3000);
    expect(result.env).toEqual({ NODE_ENV: 'production' });
    expect(result.cwd).toBe('/app');
    expect(result.instances).toBe(4);
    expect(result.healthCheck).toBeDefined();
    expect(result.healthCheck!.path).toBe('/healthz');
    expect(result.logs).toBeDefined();
    expect(result.logs!.outFile).toBe('archive/out.log');
    expect(result.metrics).toBeDefined();
    expect(result.metrics!.prometheus).toBe(true);
    expect(result.clustering).toBeDefined();
    expect(result.clustering!.strategy).toBe('reusePort');
  });

  test('throws on missing name', () => {
    expect(() => validateApp({ script: 'index.ts' })).toThrow('"name" must be a non-empty string');
  });

  test('throws on empty name', () => {
    expect(() => validateApp({ name: '', script: 'index.ts' })).toThrow(
      '"name" must be a non-empty string',
    );
  });

  test('throws on missing script', () => {
    expect(() => validateApp({ name: 'app' })).toThrow('"script" must be a non-empty string');
  });

  test('throws on empty script', () => {
    expect(() => validateApp({ name: 'app', script: '' })).toThrow(
      '"script" must be a non-empty string',
    );
  });

  test('throws on invalid instances (negative number)', () => {
    expect(() => validateApp({ name: 'app', script: 'index.ts', instances: -1 })).toThrow(
      '"instances" must be a positive integer',
    );
  });

  test('throws on invalid instances (zero)', () => {
    expect(() => validateApp({ name: 'app', script: 'index.ts', instances: 0 })).toThrow(
      '"instances" must be a positive integer',
    );
  });

  test('accepts instances: "max"', () => {
    const result = validateApp({ name: 'app', script: 'index.ts', instances: 'max' });
    expect(result.instances).toBe('max');
  });

  test('throws on invalid port (0)', () => {
    expect(() => validateApp({ name: 'app', script: 'index.ts', port: 0 })).toThrow();
  });

  test('throws on invalid port (70000)', () => {
    expect(() => validateApp({ name: 'app', script: 'index.ts', port: 70_000 })).toThrow();
  });

  test('accepts a valid port', () => {
    const result = validateApp({ name: 'app', script: 'index.ts', port: 8080 });
    expect(result.port).toBe(8080);
  });

  test('throws when input is not a plain object', () => {
    expect(() => validateApp(null)).toThrow('App config must be a plain object');
    expect(() => validateApp('string')).toThrow('App config must be a plain object');
    expect(() => validateApp(42)).toThrow('App config must be a plain object');
    expect(() => validateApp([])).toThrow('App config must be a plain object');
  });

  test('preserves interpreter field', () => {
    const result = validateApp({ name: 'app', script: 'index.ts', interpreter: 'node' });
    expect(result.interpreter).toBe('node');
  });

  test('accepts custom shutdownSignal SIGINT', () => {
    const result = validateApp({ name: 'app', script: 'index.ts', shutdownSignal: 'SIGINT' });
    expect(result.shutdownSignal).toBe('SIGINT');
  });

  test('accepts custom maxRestarts and killTimeout', () => {
    const result = validateApp({
      name: 'app',
      script: 'index.ts',
      maxRestarts: 50,
      killTimeout: 10_000,
    });
    expect(result.maxRestarts).toBe(50);
    expect(result.killTimeout).toBe(10_000);
  });

  test('rejects fractional integer-only lifecycle values', () => {
    expect(() => validateApp({ name: 'app', script: 'index.ts', maxRestarts: 1.5 })).toThrow(
      'must be an integer',
    );
    expect(() => validateApp({ name: 'app', script: 'index.ts', minUptime: 1_000.5 })).toThrow(
      'must be an integer',
    );
  });

  test('rejects app names that can escape the log directory', () => {
    expect(() => validateApp({ name: '../escape', script: 'index.ts' })).toThrow(
      'must not contain path separators',
    );
    expect(() => validateApp({ name: '..', script: 'index.ts' })).toThrow(
      'must not be "." or ".."',
    );
  });

  test('rejects control characters and unbounded app names', () => {
    expect(() => validateApp({ name: 'api\nforged', script: 'index.ts' })).toThrow(
      'control characters',
    );
    expect(() => validateApp({ name: 'a'.repeat(129), script: 'index.ts' })).toThrow('at most 128');
  });

  test('rejects invalid explicit optional strings', () => {
    expect(() => validateApp({ name: 'app', script: 'index.ts', cwd: 42 })).toThrow('"cwd"');
    expect(() => validateApp({ name: 'app', script: 'index.ts', interpreter: '' })).toThrow(
      '"interpreter"',
    );
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  test('accepts a standard multi-app config', () => {
    const result = validateConfig({
      apps: [{ name: 'a', script: 's.ts' }],
    });
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].name).toBe('a');
    expect(result.apps[0].script).toBe('s.ts');
  });

  test('accepts single-app shorthand (no apps array)', () => {
    const result = validateConfig({ name: 'a', script: 's.ts' });
    expect(result.apps).toHaveLength(1);
    expect(result.apps[0].name).toBe('a');
  });

  test('throws on duplicate app names', () => {
    expect(() =>
      validateConfig({
        apps: [
          { name: 'dup', script: 'a.ts' },
          { name: 'dup', script: 'b.ts' },
        ],
      }),
    ).toThrow('Duplicate app name "dup"');
  });

  test('throws on empty apps array', () => {
    expect(() => validateConfig({ apps: [] })).toThrow(
      '"apps" array must contain at least one app config',
    );
  });

  test('throws when config is not an object', () => {
    expect(() => validateConfig(null)).toThrow('Config must be a plain object');
    expect(() => validateConfig(42)).toThrow('Config must be a plain object');
  });

  test('throws when config has no apps and no script', () => {
    expect(() => validateConfig({ foo: 'bar' })).toThrow(
      'Config must contain an "apps" array or at minimum a "script" field',
    );
  });

  test('includes daemon config when provided', () => {
    const result = validateConfig({
      apps: [{ name: 'a', script: 's.ts' }],
      daemon: {
        pidFile: '/tmp/bunpilot.pid',
        socketFile: '/tmp/bunpilot.sock',
        logFile: '/tmp/bunpilot.log',
      },
    });

    expect(result.daemon).toBeDefined();
    expect(result.daemon!.pidFile).toBe('/tmp/bunpilot.pid');
    expect(result.daemon!.socketFile).toBe('/tmp/bunpilot.sock');
    expect(result.daemon!.logFile).toBe('/tmp/bunpilot.log');
  });

  test('validates multiple apps correctly', () => {
    const result = validateConfig({
      apps: [
        { name: 'web', script: 'web.ts', port: 3000 },
        { name: 'worker', script: 'worker.ts', instances: 2 },
        { name: 'cron', script: 'cron.ts' },
      ],
    });

    expect(result.apps).toHaveLength(3);
    expect(result.apps[0].port).toBe(3000);
    expect(result.apps[1].instances).toBe(2);
    expect(result.apps[2].name).toBe('cron');
  });

  test('rejects different metrics ports for enabled apps in one daemon', () => {
    expect(() =>
      validateConfig({
        apps: [
          { name: 'api', script: 'api.ts', metrics: { enabled: true, httpPort: 9100 } },
          { name: 'jobs', script: 'jobs.ts', metrics: { enabled: true, httpPort: 9200 } },
        ],
      }),
    ).toThrow('different metrics ports');
  });

  test('allows different metrics ports when only one app enables metrics', () => {
    expect(() =>
      validateConfig({
        apps: [
          { name: 'api', script: 'api.ts', metrics: { enabled: true, httpPort: 9100 } },
          { name: 'jobs', script: 'jobs.ts', metrics: { enabled: false, httpPort: 9200 } },
        ],
      }),
    ).not.toThrow();
  });

  test('rejects an app public port that collides with the daemon metrics listener', () => {
    expect(() =>
      validateConfig({
        apps: [{ name: 'api', script: 'api.ts', port: 9_615 }],
      }),
    ).toThrow('metrics');
  });

  test('rejects log templates that collide across worker streams', () => {
    expect(() =>
      validateConfig({
        apps: [
          {
            name: 'api',
            script: 'api.ts',
            instances: 2,
            logs: { outFile: 'combined.log', errFile: 'combined-1.log' },
          },
        ],
      }),
    ).toThrow('log files');
  });

  test('config without daemon key omits daemon property', () => {
    const result = validateConfig({
      apps: [{ name: 'a', script: 's.ts' }],
    });
    expect(result.daemon).toBeUndefined();
  });

  test('rejects malformed daemon configuration instead of silently ignoring it', () => {
    expect(() =>
      validateConfig({ apps: [{ name: 'a', script: 'a.ts' }], daemon: 'invalid' }),
    ).toThrow('"daemon" must be an object');
    expect(() =>
      validateConfig({ apps: [{ name: 'a', script: 'a.ts' }], daemon: { pidFile: 42 } }),
    ).toThrow('"daemon.pidFile"');
  });
});
