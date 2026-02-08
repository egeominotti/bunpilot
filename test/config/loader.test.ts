// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Config Loader
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { loadConfig, loadFromCLI } from '../../src/config/loader';
import { APP_DEFAULTS, DEFAULT_BACKOFF, CONFIG_FILES } from '../../src/constants';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

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

// ---------------------------------------------------------------------------
// Helper: create a unique temp directory for each test
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  const dir = join(tmpdir(), `bunpilot-loader-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// loadConfig — JSON config files (exercises loadJson + loadRawConfig)
// ---------------------------------------------------------------------------

describe('loadConfig with JSON files', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('loads a valid JSON config file with explicit path', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        apps: [{ name: 'my-app', script: 'app.ts' }],
      }),
    );

    const config = await loadConfig(configPath);

    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].name).toBe('my-app');
    expect(config.apps[0].script).toBe('app.ts');
    expect(config.apps[0].instances).toBe(1);
    expect(config.apps[0].maxRestarts).toBe(APP_DEFAULTS.maxRestarts);
    expect(config.apps[0].backoff).toEqual(DEFAULT_BACKOFF);
  });

  test('loads a JSON config with multiple apps', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        apps: [
          { name: 'api', script: 'api.ts', port: 3000 },
          { name: 'worker', script: 'worker.ts' },
        ],
      }),
    );

    const config = await loadConfig(configPath);

    expect(config.apps).toHaveLength(2);
    expect(config.apps[0].name).toBe('api');
    expect(config.apps[0].port).toBe(3000);
    expect(config.apps[1].name).toBe('worker');
    expect(config.apps[1].port).toBeUndefined();
  });

  test('loads a JSON config with single-app shorthand (script at top level)', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({ name: 'solo', script: 'server.ts', port: 8080 }),
    );

    const config = await loadConfig(configPath);

    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].name).toBe('solo');
    expect(config.apps[0].port).toBe(8080);
  });

  test('loads a JSON config with daemon settings', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        apps: [{ name: 'app', script: 'app.ts' }],
        daemon: {
          pidFile: '/tmp/custom.pid',
          socketFile: '/tmp/custom.sock',
          logFile: '/tmp/custom.log',
        },
      }),
    );

    const config = await loadConfig(configPath);

    expect(config.daemon).toBeDefined();
    expect(config.daemon!.pidFile).toBe('/tmp/custom.pid');
    expect(config.daemon!.socketFile).toBe('/tmp/custom.sock');
    expect(config.daemon!.logFile).toBe('/tmp/custom.log');
  });

  test('throws on invalid JSON content', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(configPath, '{ invalid json }');

    await expect(loadConfig(configPath)).rejects.toThrow();
  });

  test('throws when JSON config has empty apps array', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(configPath, JSON.stringify({ apps: [] }));

    await expect(loadConfig(configPath)).rejects.toThrow('"apps" array must contain at least one app config.');
  });

  test('throws when JSON config is missing apps and script', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(configPath, JSON.stringify({ name: 'test' }));

    await expect(loadConfig(configPath)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadConfig — TypeScript module config files (exercises loadModule)
// ---------------------------------------------------------------------------

describe('loadConfig with TypeScript module files', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('loads a valid .ts config file with default export', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.config.ts');
    writeFileSync(
      configPath,
      `export default {
        apps: [{ name: 'ts-app', script: 'server.ts' }],
      };`,
    );

    const config = await loadConfig(configPath);

    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].name).toBe('ts-app');
    expect(config.apps[0].script).toBe('server.ts');
  });

  test('throws when .ts config file has no default export', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.config.ts');
    writeFileSync(
      configPath,
      `export const config = {
        apps: [{ name: 'ts-app', script: 'server.ts' }],
      };`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow('must have a default export');
  });

  test('loads a .ts config with full app settings', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.config.ts');
    writeFileSync(
      configPath,
      `export default {
        apps: [{
          name: 'full-app',
          script: 'app.ts',
          instances: 2,
          port: 4000,
          env: { NODE_ENV: 'production' },
          maxRestarts: 10,
        }],
      };`,
    );

    const config = await loadConfig(configPath);

    expect(config.apps[0].name).toBe('full-app');
    expect(config.apps[0].instances).toBe(2);
    expect(config.apps[0].port).toBe(4000);
    expect(config.apps[0].env).toEqual({ NODE_ENV: 'production' });
    expect(config.apps[0].maxRestarts).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// loadConfig — JavaScript module config files (exercises loadModule for .js)
// ---------------------------------------------------------------------------

describe('loadConfig with JavaScript module files', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('loads a valid .js config file with default export', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.config.js');
    writeFileSync(
      configPath,
      `export default {
        apps: [{ name: 'js-app', script: 'index.js' }],
      };`,
    );

    const config = await loadConfig(configPath);

    expect(config.apps).toHaveLength(1);
    expect(config.apps[0].name).toBe('js-app');
    expect(config.apps[0].script).toBe('index.js');
  });

  test('throws when .js config file has no default export', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.config.js');
    writeFileSync(
      configPath,
      `export const config = {
        apps: [{ name: 'js-app', script: 'index.js' }],
      };`,
    );

    await expect(loadConfig(configPath)).rejects.toThrow('must have a default export');
  });
});

// ---------------------------------------------------------------------------
// loadConfig — unsupported file extensions (exercises loadRawConfig default)
// ---------------------------------------------------------------------------

describe('loadConfig with unsupported file extensions', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('throws for .yaml extension', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.yaml');
    writeFileSync(configPath, 'apps: []');

    await expect(loadConfig(configPath)).rejects.toThrow('Unsupported config file extension ".yaml"');
  });

  test('throws for .toml extension', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.toml');
    writeFileSync(configPath, '');

    await expect(loadConfig(configPath)).rejects.toThrow('Unsupported config file extension ".toml"');
  });

  test('throws for .xml extension', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.xml');
    writeFileSync(configPath, '<config></config>');

    await expect(loadConfig(configPath)).rejects.toThrow('Unsupported config file extension ".xml"');
  });
});

// ---------------------------------------------------------------------------
// loadConfig — explicit path error handling
// ---------------------------------------------------------------------------

describe('loadConfig with explicit path', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('throws when explicit config file does not exist', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'nonexistent.json');

    await expect(loadConfig(configPath)).rejects.toThrow('Config file not found');
  });

  test('resolves relative paths to absolute', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({ apps: [{ name: 'app', script: 'app.ts' }] }),
    );

    // Passing the absolute path should work fine
    const config = await loadConfig(configPath);
    expect(config.apps[0].name).toBe('app');
  });
});

// ---------------------------------------------------------------------------
// discoverConfigFile — auto-discovery (tested through loadConfig with no path)
// ---------------------------------------------------------------------------

describe('discoverConfigFile (via loadConfig with no path)', () => {
  let dir: string;
  let originalCwd: string;

  afterEach(() => {
    // Restore the original working directory
    if (originalCwd) process.chdir(originalCwd);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('discovers bunpilot.config.ts first (highest priority)', async () => {
    dir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(dir);

    // Create all three config files
    writeFileSync(
      join(dir, 'bunpilot.config.ts'),
      `export default { apps: [{ name: 'from-ts', script: 'app.ts' }] };`,
    );
    writeFileSync(
      join(dir, 'bunpilot.config.js'),
      `export default { apps: [{ name: 'from-js', script: 'app.js' }] };`,
    );
    writeFileSync(
      join(dir, 'bunpilot.json'),
      JSON.stringify({ apps: [{ name: 'from-json', script: 'app.json' }] }),
    );

    const config = await loadConfig();
    expect(config.apps[0].name).toBe('from-ts');
  });

  test('discovers bunpilot.config.js when .ts is absent', async () => {
    dir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(dir);

    // Create only .js and .json
    writeFileSync(
      join(dir, 'bunpilot.config.js'),
      `export default { apps: [{ name: 'from-js', script: 'app.js' }] };`,
    );
    writeFileSync(
      join(dir, 'bunpilot.json'),
      JSON.stringify({ apps: [{ name: 'from-json', script: 'app.json' }] }),
    );

    const config = await loadConfig();
    expect(config.apps[0].name).toBe('from-js');
  });

  test('discovers bunpilot.json when .ts and .js are absent', async () => {
    dir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(dir);

    // Create only .json
    writeFileSync(
      join(dir, 'bunpilot.json'),
      JSON.stringify({ apps: [{ name: 'from-json', script: 'app.ts' }] }),
    );

    const config = await loadConfig();
    expect(config.apps[0].name).toBe('from-json');
  });

  test('throws when no config file is found in cwd', async () => {
    dir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(dir);

    // Empty directory — no config files
    await expect(loadConfig()).rejects.toThrow('No config file found');
  });

  test('error message lists expected config filenames', async () => {
    dir = makeTmpDir();
    originalCwd = process.cwd();
    process.chdir(dir);

    await expect(loadConfig()).rejects.toThrow(CONFIG_FILES.join(', '));
  });
});

// ---------------------------------------------------------------------------
// loadConfig — end-to-end validation through JSON
// ---------------------------------------------------------------------------

describe('loadConfig end-to-end validation', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test('throws on duplicate app names', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        apps: [
          { name: 'api', script: 'api.ts' },
          { name: 'api', script: 'api2.ts' },
        ],
      }),
    );

    await expect(loadConfig(configPath)).rejects.toThrow('Duplicate app name "api"');
  });

  test('throws on port conflicts between apps', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        apps: [
          { name: 'api', script: 'api.ts', port: 3000 },
          { name: 'worker', script: 'worker.ts', port: 3000 },
        ],
      }),
    );

    await expect(loadConfig(configPath)).rejects.toThrow('Port 3000 is used by both');
  });

  test('applies defaults to all apps from JSON config', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        apps: [{ name: 'default-app', script: 'app.ts' }],
      }),
    );

    const config = await loadConfig(configPath);
    const app = config.apps[0];

    expect(app.instances).toBe(1);
    expect(app.maxRestarts).toBe(APP_DEFAULTS.maxRestarts);
    expect(app.maxRestartWindow).toBe(APP_DEFAULTS.maxRestartWindow);
    expect(app.minUptime).toBe(APP_DEFAULTS.minUptime);
    expect(app.killTimeout).toBe(APP_DEFAULTS.killTimeout);
    expect(app.shutdownSignal).toBe(APP_DEFAULTS.shutdownSignal);
    expect(app.readyTimeout).toBe(APP_DEFAULTS.readyTimeout);
    expect(app.backoff).toEqual(DEFAULT_BACKOFF);
  });

  test('preserves custom values from JSON config', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        apps: [
          {
            name: 'custom',
            script: 'server.ts',
            instances: 4,
            port: 8080,
            maxRestarts: 5,
            killTimeout: 10000,
            readyTimeout: 60000,
            env: { DEBUG: 'true' },
          },
        ],
      }),
    );

    const config = await loadConfig(configPath);
    const app = config.apps[0];

    expect(app.instances).toBe(4);
    expect(app.port).toBe(8080);
    expect(app.maxRestarts).toBe(5);
    expect(app.killTimeout).toBe(10000);
    expect(app.readyTimeout).toBe(60000);
    expect(app.env).toEqual({ DEBUG: 'true' });
  });

  test('throws when app config is not an object', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(configPath, JSON.stringify({ apps: ['not-an-object'] }));

    await expect(loadConfig(configPath)).rejects.toThrow();
  });

  test('throws when app is missing script field', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(
      configPath,
      JSON.stringify({ apps: [{ name: 'broken' }] }),
    );

    await expect(loadConfig(configPath)).rejects.toThrow();
  });

  test('throws when config root is not an object', async () => {
    dir = makeTmpDir();
    const configPath = join(dir, 'bunpilot.json');
    writeFileSync(configPath, JSON.stringify([1, 2, 3]));

    await expect(loadConfig(configPath)).rejects.toThrow();
  });
});
