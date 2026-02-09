// ---------------------------------------------------------------------------
// bunpilot – Process Spawn & Kill
// ---------------------------------------------------------------------------

import type { Subprocess } from 'bun';
import type { AppConfig, WorkerMessage } from '../config/types';
import { INTERNAL_ENV_KEYS, INTERNAL_PORT_BASE } from '../constants';
import { detectStrategy } from '../cluster/platform';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpawnedWorker {
  proc: Subprocess;
  pid: number;
  stdout: ReadableStream;
  stderr: ReadableStream;
}

export type OnMessageCallback = (workerId: number, msg: WorkerMessage) => void;
export type OnExitCallback = (
  workerId: number,
  exitCode: number | null,
  signalCode: string | null,
) => void;

// ---------------------------------------------------------------------------
// ProcessManager
// ---------------------------------------------------------------------------

export class ProcessManager {
  /**
   * Spawn a new worker process using `Bun.spawn`.
   *
   * Sets the standard BUNPILOT worker environment variables and strips
   * internal-only keys so they never leak to the child.
   */
  spawnWorker(
    config: AppConfig,
    workerId: number,
    onMessage: OnMessageCallback,
    onExit: OnExitCallback,
  ): SpawnedWorker {
    const env = this.buildEnv(config, workerId);
    const cmd = this.buildCommand(config);

    const proc = Bun.spawn(cmd, {
      cwd: config.cwd ?? process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      ipc(message: WorkerMessage) {
        onMessage(workerId, message);
      },
      onExit(_proc, exitCode, signalCode) {
        onExit(workerId, exitCode, signalCode as string | null);
      },
    });

    return {
      proc,
      pid: proc.pid,
      stdout: proc.stdout as ReadableStream,
      stderr: proc.stderr as ReadableStream,
    };
  }

  /**
   * Gracefully kill a worker: send `signal`, then wait up to `timeout` ms.
   * If the process hasn't exited by then, send SIGKILL.
   *
   * Resolves `'exited'` when the process left on its own or `'killed'`
   * when we had to escalate to SIGKILL.
   */
  async killWorker(pid: number, signal: string, timeout: number): Promise<'exited' | 'killed'> {
    if (!this.isRunning(pid)) return 'exited';

    // Send the initial (graceful) signal.
    try {
      process.kill(pid, signal as NodeJS.Signals);
    } catch {
      // Process already gone.
      return 'exited';
    }

    // Wait for exit or timeout.
    const exited = await this.waitForExit(pid, timeout);
    if (exited) return 'exited';

    // Escalate.
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone by the time we tried.
      return 'exited';
    }

    return 'killed';
  }

  /** Check whether a process is still alive (signal 0 trick). */
  isRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private buildCommand(config: AppConfig): string[] {
    if (config.interpreter) {
      return [config.interpreter, config.script];
    }
    return ['bun', 'run', config.script];
  }

  private buildEnv(config: AppConfig, workerId: number): Record<string, string> {
    // Start from the current process env, overlay user-defined vars.
    const base: Record<string, string> = {
      ...this.sanitizeEnv(process.env as Record<string, string>),
      ...(config.env ?? {}),
    };

    // Inject BUNPILOT worker vars.
    base['BUNPILOT_WORKER_ID'] = String(workerId);
    base['BUNPILOT_APP_NAME'] = config.name;
    base['BUNPILOT_INSTANCES'] = String(config.instances);

    // Determine clustering env based on strategy.
    const clusteringEnabled = config.clustering?.enabled === true;
    const instances = config.instances;
    const isClustered = clusteringEnabled && instances !== 1;

    if (isClustered && config.port !== undefined) {
      const strategy = detectStrategy(config.clustering?.strategy ?? 'auto');

      if (strategy === 'reusePort') {
        // Linux: all workers bind to the same public port with SO_REUSEPORT.
        base['BUNPILOT_PORT'] = String(config.port);
        base['BUNPILOT_REUSE_PORT'] = '1';
      } else {
        // proxy: each worker binds to its own internal port.
        base['BUNPILOT_PORT'] = String(INTERNAL_PORT_BASE + workerId);
        base['BUNPILOT_REUSE_PORT'] = '0';
      }
    } else {
      // Not clustered or no port configured – use config.port directly.
      if (config.port !== undefined) {
        base['BUNPILOT_PORT'] = String(config.port);
      }
      base['BUNPILOT_REUSE_PORT'] = '0';
    }

    return base;
  }

  /** Remove internal env keys that must never reach a worker. */
  private sanitizeEnv(env: Record<string, string | undefined>): Record<string, string> {
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (value !== undefined && !INTERNAL_ENV_KEYS.has(key)) {
        clean[key] = value;
      }
    }
    return clean;
  }

  /** Poll-based wait for a pid to disappear. */
  private waitForExit(pid: number, timeout: number): Promise<boolean> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = 100; // ms

      const check = () => {
        if (!this.isRunning(pid)) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= timeout) {
          resolve(false);
          return;
        }
        setTimeout(check, interval);
      };

      check();
    });
  }
}
