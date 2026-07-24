// ---------------------------------------------------------------------------
// bunpilot – Rolling Restart / Reload Handler
// ---------------------------------------------------------------------------

import type { AppConfig, WorkerInfo } from '../config/types';
import type { WorkerLifecycle } from './lifecycle';
import { pollUntil } from './poll';
import type { ProcessManager } from './process-manager';

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

      // (b) Wait until replacements are ready. H3: if a replacement dies before
      // becoming online, this throws — and we DO NOT drain the old batch, so
      // capacity is preserved and the failure surfaces instead of silently
      // losing workers after the full readyTimeout.
      await this.waitForReady(replacements, config.readyTimeout);

      // (c) + (d) Drain and stop old workers. Use allSettled, not Promise.all:
      // Promise.all rejects on the FIRST failing drain while its siblings are
      // still awaiting killWorker, and the caller's catch would then retire a
      // sibling's replacement while that sibling drain is mid-flight — killing
      // both members of the pair (h60). Waiting for every drain to settle before
      // surfacing the failure keeps the batch consistent.
      const drainResults = await Promise.allSettled(batch.map((w) => ctx.drainAndStop(w)));
      const firstFailure = drainResults.find((r) => r.status === 'rejected');
      if (firstFailure && firstFailure.status === 'rejected') {
        throw firstFailure.reason;
      }

      // (e) Inter-batch delay (skip after the last batch).
      if (i < batches.length - 1 && batchDelay > 0) {
        await this.sleep(batchDelay);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  /**
   * Wait until every worker in the list is `online`, or the timeout elapses.
   *
   * Resolves on success. A timeout is a failed deployment: draining the old
   * workers would reduce capacity and violate zero-downtime semantics. If any
   * replacement enters a terminal-failure state
   * (`crashed`/`errored`) before coming online, the predicate throws so
   * pollUntil rejects fast and the caller aborts the drain.
   */
  private async waitForReady(workers: WorkerInfo[], timeout: number): Promise<void> {
    const ready = await pollUntil(() => {
      const failed = workers.find((w) => w.state === 'crashed' || w.state === 'errored');
      if (failed) {
        throw new Error(
          `reload aborted: replacement worker ${failed.id} entered '${failed.state}' before becoming online`,
        );
      }
      return workers.every((w) => w.state === 'online');
    }, timeout);

    if (!ready) {
      throw new Error(
        `reload aborted: replacement workers did not become ready within ${timeout}ms`,
      );
    }
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
