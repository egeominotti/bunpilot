// ---------------------------------------------------------------------------
// bunpilot – Process Spawn & Kill
// ---------------------------------------------------------------------------

import type { Subprocess } from 'bun';
import { bindsWithReusePort, resolveWorkerPort } from '../cluster/policy';
import type { AppConfig, WorkerMessage } from '../config/types';
import { INTERNAL_ENV_KEYS } from '../constants';
import { isValidWorkerMessage } from '../ipc/protocol';
import { pollUntil } from './poll';

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
    portOverride?: number,
  ): SpawnedWorker {
    const env = this.buildEnv(config, workerId, portOverride);
    const cmd = this.buildCommand(config);

    const proc = Bun.spawn(cmd, {
      cwd: config.cwd ?? process.cwd(),
      env,
      stdout: 'pipe',
      stderr: 'pipe',
      ipc(message: unknown) {
        if (isValidWorkerMessage(message)) {
          onMessage(workerId, message);
        } else {
          console.warn(`[master] ignored malformed IPC message from worker ${workerId}`);
        }
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

    const sigkillTimeout = Math.max(1_000, Math.min(timeout, 5_000));
    if (!(await this.waitForExit(pid, sigkillTimeout))) {
      throw new Error(`Process ${pid} is still running after SIGKILL`);
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
    return [Bun.which('bun') ?? process.execPath, 'run', config.script];
  }

  private buildEnv(
    config: AppConfig,
    workerId: number,
    portOverride?: number,
  ): Record<string, string> {
    // Start from the current process env, overlay user-defined vars.
    const base: Record<string, string> = {
      ...this.sanitizeEnv(process.env as Record<string, string>),
      ...this.sanitizeEnv(config.env ?? {}),
    };

    // A compiled standalone bunpilot may be deployed without a separate `bun`
    // binary. In that case its own embedded runtime can act as the Bun CLI.
    if (!config.interpreter && !Bun.which('bun')) base.BUN_BE_BUN = '1';

    // Inject BUNPILOT worker vars.
    base.BUNPILOT_WORKER_ID = String(workerId);
    base.BUNPILOT_APP_NAME = config.name;
    base.BUNPILOT_INSTANCES = String(config.instances);
    // The SDK's SIGTERM/SIGINT drain must be bounded by the same killTimeout the
    // master uses before escalating to SIGKILL, not a hard-coded 5s (h56).
    base.BUNPILOT_KILL_TIMEOUT = String(config.killTimeout);

    // Port + reuse-port flag come from the shared policy so the health checker
    // (which probes the same port) can never disagree about what we bound.
    const port = portOverride ?? resolveWorkerPort(config, workerId);
    if (port !== undefined) {
      base.BUNPILOT_PORT = String(port);
    }
    base.BUNPILOT_REUSE_PORT = bindsWithReusePort(config) && config.port !== undefined ? '1' : '0';

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
    return pollUntil(() => !this.isRunning(pid), timeout);
  }
}
