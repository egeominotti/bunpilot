// ---------------------------------------------------------------------------
// bunpm – WorkerLifecycle Unit Tests
// ---------------------------------------------------------------------------

import { describe, test, expect, beforeEach } from 'bun:test';
import { WorkerLifecycle, type StateChangeListener } from '../../src/core/lifecycle';

describe('WorkerLifecycle', () => {
  let lifecycle: WorkerLifecycle;

  beforeEach(() => {
    lifecycle = new WorkerLifecycle();
  });

  // -----------------------------------------------------------------------
  // Valid transitions
  // -----------------------------------------------------------------------
  describe('valid transitions', () => {
    const validPairs: [string, string][] = [
      ['spawning', 'starting'],
      ['starting', 'online'],
      ['online', 'draining'],
      ['draining', 'stopping'],
      ['stopping', 'stopped'],
      ['stopped', 'spawning'],
      ['starting', 'crashed'],
      ['online', 'crashed'],
      ['crashed', 'spawning'],
    ];

    for (const [from, to] of validPairs) {
      test(`${from} -> ${to} is allowed`, () => {
        expect(lifecycle.canTransition(from as any, to as any)).toBe(true);
        expect(lifecycle.transition(1, from as any, to as any)).toBe(true);
      });
    }
  });

  // -----------------------------------------------------------------------
  // Invalid transitions
  // -----------------------------------------------------------------------
  describe('invalid transitions', () => {
    const invalidPairs: [string, string][] = [
      ['online', 'spawning'],
      ['stopped', 'online'],
      ['errored', 'online'],
    ];

    for (const [from, to] of invalidPairs) {
      test(`${from} -> ${to} is rejected`, () => {
        expect(lifecycle.canTransition(from as any, to as any)).toBe(false);
        expect(lifecycle.transition(1, from as any, to as any)).toBe(false);
      });
    }
  });

  // -----------------------------------------------------------------------
  // Listener behaviour
  // -----------------------------------------------------------------------
  describe('listeners', () => {
    test('listener fires on valid transition', () => {
      const calls: [number, string, string][] = [];
      const listener: StateChangeListener = (id, from, to) => {
        calls.push([id, from, to]);
      };

      lifecycle.onStateChange(listener);
      lifecycle.transition(42, 'spawning', 'starting');

      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual([42, 'spawning', 'starting']);
    });

    test('listener does NOT fire on invalid transition', () => {
      const calls: unknown[] = [];
      lifecycle.onStateChange(() => calls.push(true));
      lifecycle.transition(1, 'online', 'spawning');

      expect(calls).toHaveLength(0);
    });

    test('offStateChange removes a specific listener', () => {
      const calls: string[] = [];
      const listenerA: StateChangeListener = () => calls.push('A');
      const listenerB: StateChangeListener = () => calls.push('B');

      lifecycle.onStateChange(listenerA);
      lifecycle.onStateChange(listenerB);
      lifecycle.offStateChange(listenerA);

      lifecycle.transition(1, 'spawning', 'starting');
      expect(calls).toEqual(['B']);
    });

    test('removeAllListeners clears every listener', () => {
      const calls: string[] = [];
      lifecycle.onStateChange(() => calls.push('X'));
      lifecycle.onStateChange(() => calls.push('Y'));
      lifecycle.removeAllListeners();

      lifecycle.transition(1, 'spawning', 'starting');
      expect(calls).toHaveLength(0);
    });

    test('offStateChange is a no-op for an unregistered listener', () => {
      const listener: StateChangeListener = () => {};
      // Should not throw
      lifecycle.offStateChange(listener);
    });
  });
});
