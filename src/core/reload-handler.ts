// ---------------------------------------------------------------------------
// bunpm – Rolling Restart / Reload Handler
// ---------------------------------------------------------------------------

import type { AppConfig, WorkerInfo } from '../config/types';
import type { ProcessManager } from './process-manager';
import type { WorkerLifecycle } from './lifecycle';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReloadContext {
  config: AppConfig;
  workers: WorkerInfo[];
  processManager: ProcessManager;
  lifecycle: WorkerLifecycle;
  spawnAndTrack: (config: AppConfig, workerId: number) => WorkerInfo;
  drainAndStop: (worker: WorkerInfo) => Promise<void>;
}

// ---------------------------------------------------------------------------
// ReloadHandler
// ---------------------------------------------------------------------------

export class ReloadHandler {
  /**
   * Zero-downtime rolling restart.
   *
   * Algorithm:
   *   1. Split current workers into batches of `batchSize`.
   *   2. For each batch:
   *      a. Spawn replacement workers.
   *      b. Wait until all replacements are online (ready IPC or readyTimeout).
   *      c. Drain the old workers.
   *      d. Wait for old workers to stop.
   *      e. Pause `batchDelay` ms before the next batch.
   */
  async rollingRestart(ctx: ReloadContext): Promise<void> {
    const { config, workers } = ctx;
    const batchSize = config.clustering?.rollingRestart?.batchSize ?? 1;
    const batchDelay = config.clustering?.rollingRestart?.batchDelay ?? 1_000;

    const batches = this.chunk(workers, batchSize);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];

      // (a) Spawn replacements.
      const replacements: WorkerInfo[] = [];
      for (const old of batch) {
        const replacement = ctx.spawnAndTrack(config, old.id);
        replacements.push(replacement);
      }

      // (b) Wait until replacements are ready.
      await this.waitForReady(replacements, config.readyTimeout);

      // (c) + (d) Drain and stop old workers.
      await Promise.all(batch.map((w) => ctx.drainAndStop(w)));

      // (e) Inter-batch delay (skip after the last batch).
      if (i < batches.length - 1 && batchDelay > 0) {
        await this.sleep(batchDelay);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /** Wait until every worker in the list is `online` or timeout elapses. */
  private waitForReady(workers: WorkerInfo[], timeout: number): Promise<void> {
    return new Promise((resolve) => {
      const start = Date.now();
      const interval = 100;

      const check = () => {
        const allReady = workers.every((w) => w.state === 'online');
        if (allReady) {
          resolve();
          return;
        }
        if (Date.now() - start >= timeout) {
          // Timeout – proceed anyway to avoid deadlock.
          resolve();
          return;
        }
        setTimeout(check, interval);
      };

      check();
    });
  }

  /** Split an array into chunks of at most `size` elements. */
  private chunk<T>(arr: T[], size: number): T[][] {
    const result: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      result.push(arr.slice(i, i + size));
    }
    return result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
