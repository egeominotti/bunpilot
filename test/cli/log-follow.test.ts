import { describe, expect, test } from 'bun:test';

describe('log follow deduplication', () => {
  test('emits a newly appended duplicate line instead of hiding it', async () => {
    const module = (await import('../../src/cli/commands/logs')) as Record<string, unknown>;
    const findNewLogLines = module.findNewLogLines;
    expect(typeof findNewLogLines).toBe('function');
    expect(
      (findNewLogLines as (previous: string[], current: string[]) => string[])(
        ['A', 'B'],
        ['A', 'B', 'B'],
      ),
    ).toEqual(['B']);
  });
});
