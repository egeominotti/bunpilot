import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveDaemonPaths } from '../../src/daemon/paths';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveDaemonPaths', () => {
  test('returns absolute custom paths from a validated config without filesystem side effects', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bunpilot-daemon-paths-'));
    directories.push(directory);
    const configPath = join(directory, 'bunpilot.json');
    const pidFile = join(directory, 'runtime', 'custom.pid');
    const socketFile = join(directory, 'runtime', 'custom.sock');
    const logFile = join(directory, 'logs', 'daemon.log');
    await Bun.write(
      configPath,
      JSON.stringify({
        apps: [{ name: 'app', script: 'app.ts' }],
        daemon: { pidFile, socketFile, logFile },
      }),
    );

    await expect(resolveDaemonPaths(configPath)).resolves.toEqual({
      pidFile: resolve(pidFile),
      socketFile: resolve(socketFile),
      logFile: resolve(logFile),
    });
    expect(existsSync(join(directory, 'runtime'))).toBe(false);
    expect(existsSync(join(directory, 'logs'))).toBe(false);
  });

  test('rejects daemon paths that resolve to the same filesystem entry', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bunpilot-daemon-paths-'));
    directories.push(directory);
    const configPath = join(directory, 'bunpilot.json');
    const sharedPath = join(directory, 'runtime', 'daemon.state');
    await Bun.write(
      configPath,
      JSON.stringify({
        apps: [{ name: 'app', script: 'app.ts' }],
        daemon: {
          pidFile: sharedPath,
          socketFile: join(directory, 'runtime', '.', 'daemon.state'),
          logFile: join(directory, 'runtime', 'daemon.log'),
        },
      }),
    );

    await expect(resolveDaemonPaths(configPath)).rejects.toThrow('distinct');
  });
});
