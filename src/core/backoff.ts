// ---------------------------------------------------------------------------
// bunpilot – Crash Recovery with Exponential Backoff
// ---------------------------------------------------------------------------

import type { AppConfig, BackoffState } from '../config/types';

// ---------------------------------------------------------------------------
// CrashRecovery
// ---------------------------------------------------------------------------

export class CrashRecovery {
  private readonly states = new Map<number | string, BackoffState>();

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
  onWorkerCrash(
    workerId: number,
    config: AppConfig,
    namespace: string = '',
  ): 'restart' | 'give-up' {
    const now = Date.now();
    const state = this.getOrCreate(this.key(workerId, namespace), now);

    // Slide the window: reset counter when the window has elapsed.
    if (now - state.windowStart >= config.maxRestartWindow) {
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
  onWorkerStable(workerId: number, namespace: string = ''): void {
    const state = this.states.get(this.key(workerId, namespace));
    if (state) {
      state.consecutiveCrashes = 0;
    }
  }

  /** Returns the number of milliseconds to wait before the next restart. */
  getDelay(workerId: number, namespace: string = ''): number {
    const state = this.states.get(this.key(workerId, namespace));
    if (!state) return 0;

    const remaining = state.nextRestartAt - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /** Full reset – removes all tracking data for the given worker. */
  reset(workerId: number, namespace: string = ''): void {
    this.states.delete(this.key(workerId, namespace));
  }

  /** Full reset of all workers. */
  resetAll(): void {
    this.states.clear();
  }

  /** Read-only access to backoff state (useful for status/debug). */
  getState(workerId: number, namespace: string = ''): BackoffState | undefined {
    return this.states.get(this.key(workerId, namespace));
  }

  // -----------------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------------

  private getOrCreate(key: number | string, now: number): BackoffState {
    let state = this.states.get(key);
    if (!state) {
      state = {
        consecutiveCrashes: 0,
        lastCrashAt: 0,
        nextRestartAt: 0,
        totalRestarts: 0,
        windowStart: now,
        restartsInWindow: 0,
      };
      this.states.set(key, state);
    }
    return state;
  }

  private key(workerId: number, namespace: string): number | string {
    return namespace.length === 0 ? workerId : `${namespace}\0${workerId}`;
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
    const raw = backoff.initial * backoff.multiplier ** exponent;
    return Math.min(raw, backoff.max);
  }
}
