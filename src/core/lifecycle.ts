// ---------------------------------------------------------------------------
// bunpm2 – Worker State Machine
// ---------------------------------------------------------------------------

import { TRANSITIONS, type WorkerState } from '../config/types';

// ---------------------------------------------------------------------------
// Listener type
// ---------------------------------------------------------------------------

export type StateChangeListener = (workerId: number, from: WorkerState, to: WorkerState) => void;

// ---------------------------------------------------------------------------
// WorkerLifecycle
// ---------------------------------------------------------------------------

export class WorkerLifecycle {
  private readonly listeners: StateChangeListener[] = [];

  /** Check whether a transition from `from` to `to` is allowed. */
  canTransition(from: WorkerState, to: WorkerState): boolean {
    const allowed = TRANSITIONS[from];
    return allowed !== undefined && allowed.includes(to);
  }

  /**
   * Attempt to transition a worker from one state to another.
   *
   * Returns `true` when the transition is valid and all listeners have been
   * notified.  Returns `false` when the transition is not allowed – no
   * listeners are called in that case.
   */
  transition(workerId: number, from: WorkerState, to: WorkerState): boolean {
    if (!this.canTransition(from, to)) {
      return false;
    }

    for (const listener of this.listeners) {
      listener(workerId, from, to);
    }

    return true;
  }

  /** Register a callback that fires on every successful state transition. */
  onStateChange(listener: StateChangeListener): void {
    this.listeners.push(listener);
  }

  /** Remove a previously registered listener. */
  offStateChange(listener: StateChangeListener): void {
    const idx = this.listeners.indexOf(listener);
    if (idx !== -1) {
      this.listeners.splice(idx, 1);
    }
  }

  /** Remove all listeners. */
  removeAllListeners(): void {
    this.listeners.length = 0;
  }
}
