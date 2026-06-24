// ---------------------------------------------------------------------------
// bunpilot – pollUntil Unit Tests
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import { pollUntil, DEFAULT_POLL_INTERVAL } from '../../src/core/poll';

describe('pollUntil', () => {
  test('resolves true immediately when predicate is already satisfied', async () => {
    const start = Date.now();
    const result = await pollUntil(() => true, 1_000);
    expect(result).toBe(true);
    // Should not have waited a full interval.
    expect(Date.now() - start).toBeLessThan(DEFAULT_POLL_INTERVAL);
  });

  test('resolves true once the predicate becomes satisfied', async () => {
    let flag = false;
    setTimeout(() => {
      flag = true;
    }, 120);

    const result = await pollUntil(() => flag, 2_000, 20);
    expect(result).toBe(true);
  });

  test('resolves false when the timeout elapses first', async () => {
    const start = Date.now();
    const result = await pollUntil(() => false, 150, 20);
    expect(result).toBe(false);
    // It should have waited at least the timeout before giving up.
    expect(Date.now() - start).toBeGreaterThanOrEqual(140);
  });

  test('rejects when the predicate throws (early abort)', async () => {
    const boom = new Error('abort');
    let calls = 0;

    await expect(
      pollUntil(() => {
        calls += 1;
        throw boom;
      }, 1_000, 20),
    ).rejects.toBe(boom);

    // Predicate is only evaluated once before the rejection.
    expect(calls).toBe(1);
  });

  test('honours a custom interval', async () => {
    let count = 0;
    const result = await pollUntil(() => {
      count += 1;
      return count >= 3;
    }, 1_000, 30);

    expect(result).toBe(true);
    expect(count).toBe(3);
  });
});
