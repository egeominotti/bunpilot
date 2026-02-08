// ---------------------------------------------------------------------------
// bunpm2 – Process Spawn & Kill
// ---------------------------------------------------------------------------

import type { Subprocess } from 'bun';
import type { AppConfig, WorkerMessage } from '../config/types';
import { INTERNAL_ENV_KEYS } from '../constants';

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
   * Sets the standard BUNPM2 worker environment variables and strips
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

    // Inject BUNPM2 worker vars.
    base['BUNPM2_WORKER_ID'] = String(workerId);
    if (config.port !== undefined) {
      base['BUNPM2_PORT'] = String(config.port);
    }
    base['BUNPM2_REUSE_PORT'] = '1';
    base['BUNPM2_APP_NAME'] = config.name;
    base['BUNPM2_INSTANCES'] = String(config.instances);

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
