// ---------------------------------------------------------------------------
// bunpilot – ProcessManager Unit Tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessManager, type SpawnedWorker } from '../../src/core/process-manager';
import type { AppConfig, WorkerMessage } from '../../src/config/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;
let pm: ProcessManager;

/** Track all spawned processes so we can clean them up in afterEach. */
const spawnedPids: number[] = [];

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'test-app',
    script: join(tempDir, 'worker.ts'),
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
    ...overrides,
  };
}

/** Write a temporary TypeScript file that can be spawned as a worker. */
function writeWorkerScript(filename: string, code: string): string {
  const filePath = join(tempDir, filename);
  writeFileSync(filePath, code, 'utf-8');
  return filePath;
}

/** Force-kill a PID if it is still running, ignoring errors. */
function forceKill(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead — ignore.
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'bunpilot-pm-test-'));
  pm = new ProcessManager();
});

afterEach(() => {
  // Kill every process spawned during the test.
  for (const pid of spawnedPids) {
    forceKill(pid);
  }
  spawnedPids.length = 0;

  // Remove temp dir.
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isRunning
// ---------------------------------------------------------------------------

describe('ProcessManager', () => {
  describe('isRunning', () => {
    test('returns true for the current process PID', () => {
      expect(pm.isRunning(process.pid)).toBe(true);
    });

    test('returns false for a non-existent PID', () => {
      // PID 99999999 is almost certainly not a running process.
      expect(pm.isRunning(99_999_999)).toBe(false);
    });

    test('returns false for a very large PID that cannot exist', () => {
      // Use a PID in the range that no real process would have.
      expect(pm.isRunning(4_194_305)).toBe(false);
    });

    test('returns false after a process has been killed', async () => {
      // Spawn a short-lived process and wait for it to exit.
      const script = writeWorkerScript(
        'short-lived.ts',
        'setTimeout(() => process.exit(0), 50);',
      );
      const config = makeConfig({ script });

      const spawned = pm.spawnWorker(config, 0, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      // Wait for the process to exit.
      await new Promise((resolve) => setTimeout(resolve, 300));

      expect(pm.isRunning(spawned.pid)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // spawnWorker
  // -------------------------------------------------------------------------

  describe('spawnWorker', () => {
    test('returns a SpawnedWorker with pid, proc, stdout, stderr', () => {
      const script = writeWorkerScript(
        'basic.ts',
        'setTimeout(() => process.exit(0), 5000);',
      );
      const config = makeConfig({ script });

      const spawned = pm.spawnWorker(config, 1, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      expect(spawned.pid).toBeGreaterThan(0);
      expect(spawned.proc).toBeDefined();
      expect(spawned.stdout).toBeDefined();
      expect(spawned.stderr).toBeDefined();
    });

    test('invokes onExit callback when child process exits', async () => {
      const script = writeWorkerScript(
        'exit-fast.ts',
        'process.exit(42);',
      );
      const config = makeConfig({ script });

      const exitResult = await new Promise<{
        workerId: number;
        exitCode: number | null;
        signalCode: string | null;
      }>((resolve) => {
        const spawned = pm.spawnWorker(config, 7, () => {}, (wid, ec, sc) => {
          resolve({ workerId: wid, exitCode: ec, signalCode: sc });
        });
        spawnedPids.push(spawned.pid);
      });

      expect(exitResult.workerId).toBe(7);
      expect(exitResult.exitCode).toBe(42);
    });

    test('invokes onMessage callback for IPC messages', async () => {
      const script = writeWorkerScript(
        'ipc-ready.ts',
        `
        // Send a ready message via IPC, then exit.
        process.send?.({ type: 'ready' });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      const config = makeConfig({ script });

      const messageResult = await new Promise<{
        workerId: number;
        msg: WorkerMessage;
      }>((resolve) => {
        const spawned = pm.spawnWorker(config, 3, (wid, msg) => {
          resolve({ workerId: wid, msg });
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(messageResult.workerId).toBe(3);
      expect(messageResult.msg).toEqual({ type: 'ready' });
    });

    test('sets BUNPILOT_WORKER_ID environment variable', async () => {
      const script = writeWorkerScript(
        'env-check.ts',
        `
        const wid = process.env.BUNPILOT_WORKER_ID;
        process.send?.({ type: 'custom', channel: 'env', data: { workerId: wid } });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      const config = makeConfig({ script });

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 5, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        expect((msg.data as Record<string, string>).workerId).toBe('5');
      }
    });

    test('sets BUNPILOT_APP_NAME environment variable', async () => {
      const script = writeWorkerScript(
        'env-name.ts',
        `
        const appName = process.env.BUNPILOT_APP_NAME;
        process.send?.({ type: 'custom', channel: 'env', data: { appName } });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      const config = makeConfig({ script, name: 'my-awesome-app' });

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 0, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        expect((msg.data as Record<string, string>).appName).toBe('my-awesome-app');
      }
    });

    test('sets BUNPILOT_INSTANCES environment variable', async () => {
      const script = writeWorkerScript(
        'env-instances.ts',
        `
        const instances = process.env.BUNPILOT_INSTANCES;
        process.send?.({ type: 'custom', channel: 'env', data: { instances } });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      const config = makeConfig({ script, instances: 4 });

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 0, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        expect((msg.data as Record<string, string>).instances).toBe('4');
      }
    });

    test('does not leak internal env keys to child process', async () => {
      // Set an internal env key in the current process.
      process.env.BUNPILOT_DAEMON = '1';
      process.env.BUNPILOT_CONTROL_SOCKET = '/tmp/test.sock';

      const script = writeWorkerScript(
        'env-leak.ts',
        `
        const daemon = process.env.BUNPILOT_DAEMON ?? 'undefined';
        const socket = process.env.BUNPILOT_CONTROL_SOCKET ?? 'undefined';
        process.send?.({
          type: 'custom',
          channel: 'env',
          data: { daemon, socket },
        });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      const config = makeConfig({ script });

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 0, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      // Cleanup env after test.
      delete process.env.BUNPILOT_DAEMON;
      delete process.env.BUNPILOT_CONTROL_SOCKET;

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        const data = msg.data as Record<string, string>;
        expect(data.daemon).toBe('undefined');
        expect(data.socket).toBe('undefined');
      }
    });

    test('overlays user-defined env from config', async () => {
      const script = writeWorkerScript(
        'env-custom.ts',
        `
        const myVar = process.env.MY_CUSTOM_VAR;
        process.send?.({ type: 'custom', channel: 'env', data: { myVar } });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      const config = makeConfig({ script, env: { MY_CUSTOM_VAR: 'hello-bunpilot' } });

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 0, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        expect((msg.data as Record<string, string>).myVar).toBe('hello-bunpilot');
      }
    });

    test('uses config.cwd as working directory', async () => {
      const script = writeWorkerScript(
        'cwd-check.ts',
        `
        process.send?.({ type: 'custom', channel: 'cwd', data: { cwd: process.cwd() } });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      const config = makeConfig({ script, cwd: tempDir });

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 0, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        const data = msg.data as Record<string, string>;
        // On macOS, /var is a symlink to /private/var. Resolve both sides.
        expect(realpathSync(data.cwd)).toBe(realpathSync(tempDir));
      }
    });

    test('uses interpreter when specified in config', () => {
      const script = writeWorkerScript(
        'interp.ts',
        'setTimeout(() => process.exit(0), 5000);',
      );
      const config = makeConfig({ script, interpreter: 'bun' });

      // We can't easily inspect the command array, but we can spawn and verify
      // the process starts. With interpreter='bun', the command should be
      // ['bun', script] instead of ['bun', 'run', script].
      const spawned = pm.spawnWorker(config, 0, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      expect(spawned.pid).toBeGreaterThan(0);
    });

    test('captures stdout from child process', async () => {
      const script = writeWorkerScript(
        'stdout.ts',
        `
        console.log('hello from stdout');
        setTimeout(() => process.exit(0), 200);
        `,
      );
      const config = makeConfig({ script });

      const spawned = pm.spawnWorker(config, 0, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      const reader = spawned.stdout.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);

      expect(text).toContain('hello from stdout');
    });

    test('captures stderr from child process', async () => {
      const script = writeWorkerScript(
        'stderr.ts',
        `
        console.error('hello from stderr');
        setTimeout(() => process.exit(0), 200);
        `,
      );
      const config = makeConfig({ script });

      const spawned = pm.spawnWorker(config, 0, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      const reader = spawned.stderr.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);

      expect(text).toContain('hello from stderr');
    });
  });

  // -------------------------------------------------------------------------
  // killWorker
  // -------------------------------------------------------------------------

  describe('killWorker', () => {
    test('returns "exited" for a non-running PID', async () => {
      const result = await pm.killWorker(99_999_999, 'SIGTERM', 1_000);
      expect(result).toBe('exited');
    });

    test('returns "exited" when process exits gracefully on SIGTERM', async () => {
      const script = writeWorkerScript(
        'graceful.ts',
        `
        process.on('SIGTERM', () => {
          process.exit(0);
        });
        // Keep alive forever until signal.
        setInterval(() => {}, 100_000);
        `,
      );
      const config = makeConfig({ script });

      const spawned = pm.spawnWorker(config, 0, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      // Give the process a moment to start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = await pm.killWorker(spawned.pid, 'SIGTERM', 3_000);
      expect(result).toBe('exited');
      expect(pm.isRunning(spawned.pid)).toBe(false);
    });

    test('returns "killed" when process ignores SIGTERM and is escalated to SIGKILL', async () => {
      const script = writeWorkerScript(
        'stubborn.ts',
        `
        // Ignore SIGTERM — force escalation to SIGKILL.
        process.on('SIGTERM', () => {
          // Do nothing.
        });
        // Keep alive forever.
        setInterval(() => {}, 100_000);
        `,
      );
      const config = makeConfig({ script });

      const spawned = pm.spawnWorker(config, 0, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      // Give the process a moment to start.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // Use a short timeout to trigger escalation quickly.
      const result = await pm.killWorker(spawned.pid, 'SIGTERM', 500);
      expect(result).toBe('killed');

      // Give SIGKILL a moment to take effect.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(pm.isRunning(spawned.pid)).toBe(false);
    });

    test('returns "exited" when process is already dead at the time of kill', async () => {
      const script = writeWorkerScript(
        'already-dead.ts',
        'process.exit(0);',
      );
      const config = makeConfig({ script });

      const spawned = pm.spawnWorker(config, 0, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      // Wait for process to exit on its own.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const result = await pm.killWorker(spawned.pid, 'SIGTERM', 1_000);
      expect(result).toBe('exited');
    });

    test('handles SIGINT signal gracefully', async () => {
      const script = writeWorkerScript(
        'sigint-handler.ts',
        `
        process.on('SIGINT', () => {
          process.exit(0);
        });
        setInterval(() => {}, 100_000);
        `,
      );
      const config = makeConfig({ script });

      const spawned = pm.spawnWorker(config, 0, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      await new Promise((resolve) => setTimeout(resolve, 200));

      const result = await pm.killWorker(spawned.pid, 'SIGINT', 3_000);
      expect(result).toBe('exited');
      expect(pm.isRunning(spawned.pid)).toBe(false);
    });

    test('kills a process that exits slowly within timeout', async () => {
      const script = writeWorkerScript(
        'slow-exit.ts',
        `
        process.on('SIGTERM', () => {
          // Simulate slow cleanup — exit after 200ms.
          setTimeout(() => process.exit(0), 200);
        });
        setInterval(() => {}, 100_000);
        `,
      );
      const config = makeConfig({ script });

      const spawned = pm.spawnWorker(config, 0, () => {}, () => {});
      spawnedPids.push(spawned.pid);

      await new Promise((resolve) => setTimeout(resolve, 200));

      // Timeout of 2s is well above the 200ms cleanup time.
      const result = await pm.killWorker(spawned.pid, 'SIGTERM', 2_000);
      expect(result).toBe('exited');
    });
  });

  // -------------------------------------------------------------------------
  // Port / Clustering environment
  // -------------------------------------------------------------------------

  describe('clustering environment variables', () => {
    test('sets BUNPILOT_PORT when port is configured (non-clustered)', async () => {
      const script = writeWorkerScript(
        'env-port.ts',
        `
        const port = process.env.BUNPILOT_PORT;
        const reusePort = process.env.BUNPILOT_REUSE_PORT;
        process.send?.({ type: 'custom', channel: 'env', data: { port, reusePort } });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      // instances=1 means not clustered.
      const config = makeConfig({ script, port: 3000, instances: 1 });

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 0, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        const data = msg.data as Record<string, string>;
        expect(data.port).toBe('3000');
        expect(data.reusePort).toBe('0');
      }
    });

    test('sets BUNPILOT_REUSE_PORT to 0 when no port is configured', async () => {
      const script = writeWorkerScript(
        'env-no-port.ts',
        `
        const port = process.env.BUNPILOT_PORT ?? 'undefined';
        const reusePort = process.env.BUNPILOT_REUSE_PORT;
        process.send?.({ type: 'custom', channel: 'env', data: { port, reusePort } });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      // No port configured, single instance.
      const config = makeConfig({ script, instances: 1 });

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 0, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        const data = msg.data as Record<string, string>;
        expect(data.port).toBe('undefined');
        expect(data.reusePort).toBe('0');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('clustering not explicitly enabled (Bug 9)', () => {
    test('multi-instance app without clustering config uses configured port, not internal port', async () => {
      const script = writeWorkerScript(
        'env-port-nocluster.ts',
        `
        const port = process.env.BUNPILOT_PORT;
        const reusePort = process.env.BUNPILOT_REUSE_PORT;
        process.send?.({ type: 'custom', channel: 'env', data: { port, reusePort } });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      // Multiple instances, port configured, but NO clustering config at all
      const config = makeConfig({ script, port: 3000, instances: 4 });
      // Explicitly no clustering config (undefined)
      delete (config as any).clustering;

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 0, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        const data = msg.data as Record<string, string>;
        // Without explicit clustering enabled, should use the configured port directly
        expect(data.port).toBe('3000');
        expect(data.reusePort).toBe('0');
      }
    });

    test('multi-instance app with clustering explicitly enabled uses internal port', async () => {
      const script = writeWorkerScript(
        'env-port-cluster.ts',
        `
        const port = process.env.BUNPILOT_PORT;
        process.send?.({ type: 'custom', channel: 'env', data: { port } });
        setTimeout(() => process.exit(0), 500);
        `,
      );
      // Multiple instances with clustering EXPLICITLY enabled
      const config = makeConfig({
        script,
        port: 3000,
        instances: 4,
        clustering: {
          enabled: true,
          strategy: 'proxy',
          rollingRestart: { batchSize: 1, batchDelay: 1000 },
        },
      });

      const msg = await new Promise<WorkerMessage>((resolve) => {
        const spawned = pm.spawnWorker(config, 0, (_wid, m) => {
          resolve(m);
        }, () => {});
        spawnedPids.push(spawned.pid);
      });

      expect(msg).toHaveProperty('type', 'custom');
      if (msg.type === 'custom') {
        const data = msg.data as Record<string, string>;
        // With clustering enabled and proxy strategy, should use internal port
        expect(data.port).toBe(String(40001)); // INTERNAL_PORT_BASE + workerId(0)
      }
    });
  });

  describe('edge cases', () => {
    test('multiple workers can be spawned concurrently', async () => {
      const script = writeWorkerScript(
        'multi.ts',
        `
        const wid = process.env.BUNPILOT_WORKER_ID;
        process.send?.({ type: 'custom', channel: 'id', data: { wid } });
        setTimeout(() => process.exit(0), 1000);
        `,
      );
      const config = makeConfig({ script, instances: 3 });

      const messages: string[] = [];
      const promises: Promise<void>[] = [];

      for (let i = 0; i < 3; i++) {
        promises.push(
          new Promise<void>((resolve) => {
            const spawned = pm.spawnWorker(config, i, (_wid, m) => {
              if (m.type === 'custom') {
                messages.push((m.data as Record<string, string>).wid);
              }
              resolve();
            }, () => {});
            spawnedPids.push(spawned.pid);
          }),
        );
      }

      await Promise.all(promises);

      expect(messages).toHaveLength(3);
      expect(messages.sort()).toEqual(['0', '1', '2']);
    });

    test('spawnWorker assigns unique PIDs to each worker', () => {
      const script = writeWorkerScript(
        'unique-pid.ts',
        'setInterval(() => {}, 100_000);',
      );
      const config = makeConfig({ script });

      const pids = new Set<number>();
      for (let i = 0; i < 3; i++) {
        const spawned = pm.spawnWorker(config, i, () => {}, () => {});
        spawnedPids.push(spawned.pid);
        pids.add(spawned.pid);
      }

      expect(pids.size).toBe(3);
    });
  });
});
