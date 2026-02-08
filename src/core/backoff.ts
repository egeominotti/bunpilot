// ---------------------------------------------------------------------------
// bunpm2 – Crash Recovery with Exponential Backoff
// ---------------------------------------------------------------------------

import type { AppConfig, BackoffState } from '../config/types';

// ---------------------------------------------------------------------------
// CrashRecovery
// ---------------------------------------------------------------------------

export class CrashRecovery {
  private readonly states = new Map<number, BackoffState>();

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Called when a worker crashes.
   *
   * Tracks crash counts inside a sliding window (`maxRestartWindow`).
   * Returns `'restart'` when we should try again and `'give-up'` when the
   * worker exceeded `maxRestarts` inside the current window.
   */
  onWorkerCrash(workerId: number, config: AppConfig): 'restart' | 'give-up' {
    const now = Date.now();
    const state = this.getOrCreate(workerId, now);

    // Slide the window: reset counter when the window has elapsed.
    if (now - state.windowStart > config.maxRestartWindow) {
      state.windowStart = now;
      state.restartsInWindow = 0;
    }

    state.consecutiveCrashes += 1;
    state.restartsInWindow += 1;
    state.totalRestarts += 1;
    state.lastCrashAt = now;

    // Compute the delay for the *next* restart and store it.
    state.nextRestartAt = now + this.computeDelay(state, config.backoff);

    if (state.restartsInWindow > config.maxRestarts) {
      return 'give-up';
    }

    return 'restart';
  }

  /**
   * Called when a worker has been running stably for longer than
   * `minUptime`.  Resets the consecutive crash counter so the next crash
   * starts a fresh exponential back-off curve.
   */
  onWorkerStable(workerId: number): void {
    const state = this.states.get(workerId);
    if (state) {
      state.consecutiveCrashes = 0;
    }
  }

  /** Returns the number of milliseconds to wait before the next restart. */
  getDelay(workerId: number): number {
    const state = this.states.get(workerId);
    if (!state) return 0;

    const remaining = state.nextRestartAt - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /** Full reset – removes all tracking data for the given worker. */
  reset(workerId: number): void {
    this.states.delete(workerId);
  }

  /** Full reset of all workers. */
  resetAll(): void {
    this.states.clear();
  }

  /** Read-only access to backoff state (useful for status/debug). */
  getState(workerId: number): BackoffState | undefined {
    return this.states.get(workerId);
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private getOrCreate(workerId: number, now: number): BackoffState {
    let state = this.states.get(workerId);
    if (!state) {
      state = {
        consecutiveCrashes: 0,
        lastCrashAt: 0,
        nextRestartAt: 0,
        totalRestarts: 0,
        windowStart: now,
        restartsInWindow: 0,
      };
      this.states.set(workerId, state);
    }
    return state;
  }

  /**
   * Exponential back-off:
   *   delay = min(initial * multiplier^(crashes - 1), max)
   */
  private computeDelay(
    state: BackoffState,
    backoff: { initial: number; multiplier: number; max: number },
  ): number {
    const exponent = Math.max(0, state.consecutiveCrashes - 1);
    const raw = backoff.initial * Math.pow(backoff.multiplier, exponent);
    return Math.min(raw, backoff.max);
  }
}
