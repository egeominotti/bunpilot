// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Config Loader: loadFromCLI
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { loadFromCLI } from '../../src/config/loader';
import { APP_DEFAULTS, DEFAULT_BACKOFF } from '../../src/constants';

// ---------------------------------------------------------------------------
// loadFromCLI
// ---------------------------------------------------------------------------

describe('loadFromCLI', () => {
  test('creates a valid AppConfig from minimal CLI args', () => {
    const config = loadFromCLI({ script: 'app.ts' });

    expect(config.script).toBe('app.ts');
    expect(config.name).toBe('app');
    expect(config.instances).toBe(1);
    expect(config.maxRestarts).toBe(APP_DEFAULTS.maxRestarts);
    expect(config.killTimeout).toBe(APP_DEFAULTS.killTimeout);
    expect(config.shutdownSignal).toBe(APP_DEFAULTS.shutdownSignal);
    expect(config.readyTimeout).toBe(APP_DEFAULTS.readyTimeout);
    expect(config.backoff).toEqual(DEFAULT_BACKOFF);
  });

  test('uses provided name instead of derived name', () => {
    const config = loadFromCLI({ script: 'server.ts', name: 'my-api' });
    expect(config.name).toBe('my-api');
  });

  test('sets instances when provided', () => {
    const config = loadFromCLI({ script: 'app.ts', instances: 4 });
    expect(config.instances).toBe(4);
  });

  test('supports "max" for instances', () => {
    const config = loadFromCLI({ script: 'app.ts', instances: 'max' });
    expect(config.instances).toBe('max');
  });

  test('sets port when provided', () => {
    const config = loadFromCLI({ script: 'app.ts', port: 3000 });
    expect(config.port).toBe(3000);
  });

  test('omits port when not provided', () => {
    const config = loadFromCLI({ script: 'app.ts' });
    expect(config.port).toBeUndefined();
  });

  test('merges env when provided', () => {
    const config = loadFromCLI({
      script: 'app.ts',
      env: { NODE_ENV: 'production', API_KEY: 'secret' },
    });
    expect(config.env).toEqual({ NODE_ENV: 'production', API_KEY: 'secret' });
  });

  test('omits env when not provided', () => {
    const config = loadFromCLI({ script: 'app.ts' });
    expect(config.env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Name derivation from script paths
// ---------------------------------------------------------------------------

describe('deriveAppName (via loadFromCLI)', () => {
  test('derives name from simple filename', () => {
    const config = loadFromCLI({ script: 'server.ts' });
    expect(config.name).toBe('server');
  });

  test('derives name from relative path', () => {
    const config = loadFromCLI({ script: './src/server.ts' });
    expect(config.name).toBe('server');
  });

  test('derives name from absolute path', () => {
    const config = loadFromCLI({ script: '/opt/my-app.ts' });
    expect(config.name).toBe('my-app');
  });

  test('derives name from .js extension', () => {
    const config = loadFromCLI({ script: 'app.js' });
    expect(config.name).toBe('app');
  });

  test('derives name from nested path', () => {
    const config = loadFromCLI({ script: 'src/api/handler.ts' });
    expect(config.name).toBe('handler');
  });

  test('handles filename with multiple dots', () => {
    const config = loadFromCLI({ script: 'my.api.server.ts' });
    // lastIndexOf('.') strips only the last extension
    expect(config.name).toBe('my.api.server');
  });

  test('handles filename with no extension', () => {
    const config = loadFromCLI({ script: 'myserver' });
    expect(config.name).toBe('myserver');
  });
});

// ---------------------------------------------------------------------------
// Validation via loadFromCLI
// ---------------------------------------------------------------------------

describe('loadFromCLI validation', () => {
  test('throws when script is missing', () => {
    expect(() => loadFromCLI({ script: '' })).toThrow();
  });

  test('throws when instances is 0', () => {
    expect(() => loadFromCLI({ script: 'app.ts', instances: 0 })).toThrow();
  });

  test('throws when instances is negative', () => {
    expect(() => loadFromCLI({ script: 'app.ts', instances: -1 })).toThrow();
  });

  test('throws when port is out of range', () => {
    expect(() => loadFromCLI({ script: 'app.ts', port: 99999 })).toThrow();
  });

  test('applies all default values correctly', () => {
    const config = loadFromCLI({ script: 'app.ts' });

    expect(config.maxRestarts).toBe(APP_DEFAULTS.maxRestarts);
    expect(config.maxRestartWindow).toBe(APP_DEFAULTS.maxRestartWindow);
    expect(config.minUptime).toBe(APP_DEFAULTS.minUptime);
    expect(config.killTimeout).toBe(APP_DEFAULTS.killTimeout);
    expect(config.shutdownSignal).toBe(APP_DEFAULTS.shutdownSignal);
    expect(config.readyTimeout).toBe(APP_DEFAULTS.readyTimeout);
  });
});
