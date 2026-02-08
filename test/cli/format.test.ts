// ---------------------------------------------------------------------------
// bunpm – Unit Tests for CLI Format Utilities
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  formatTable,
  formatUptime,
  formatMemory,
  formatState,
} from '../../src/cli/format';

// ---------------------------------------------------------------------------
// formatTable
// ---------------------------------------------------------------------------

describe('formatTable', () => {
  test('produces aligned output with headers and rows', () => {
    const headers = ['NAME', 'STATUS', 'PID'];
    const rows = [
      ['my-app', 'online', '1234'],
      ['worker-2', 'stopped', '—'],
    ];

    const result = formatTable(headers, rows);
    const lines = result.split('\n');

    // Should have header + 2 data rows
    expect(lines).toHaveLength(3);

    // Header line should contain all headers
    expect(lines[0]).toContain('NAME');
    expect(lines[0]).toContain('STATUS');
    expect(lines[0]).toContain('PID');

    // Data lines should contain their values
    expect(lines[1]).toContain('my-app');
    expect(lines[1]).toContain('online');
    expect(lines[1]).toContain('1234');

    expect(lines[2]).toContain('worker-2');
    expect(lines[2]).toContain('stopped');
  });

  test('columns use the separator character', () => {
    const headers = ['A', 'B'];
    const rows = [['x', 'y']];
    const result = formatTable(headers, rows);

    // The separator uses the Unicode box-drawing character │
    expect(result).toContain('\u2502');
  });

  test('returns only the header line when rows are empty', () => {
    const headers = ['NAME', 'STATUS'];
    const rows: string[][] = [];

    const result = formatTable(headers, rows);
    const lines = result.split('\n');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('NAME');
    expect(lines[0]).toContain('STATUS');
  });

  test('returns empty string when headers are empty', () => {
    const result = formatTable([], []);
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// formatUptime
// ---------------------------------------------------------------------------

describe('formatUptime', () => {
  test('displays seconds for durations under 60s', () => {
    expect(formatUptime(45000)).toBe('45s');
  });

  test('displays minutes and seconds for durations under 1h', () => {
    expect(formatUptime(135000)).toBe('2m 15s');
  });

  test('displays hours and minutes for durations under 1d', () => {
    expect(formatUptime(7500000)).toBe('2h 5m');
  });

  test('displays days and hours for durations >= 1d', () => {
    expect(formatUptime(90000000)).toBe('1d 1h');
  });

  test('returns 0s for negative values', () => {
    expect(formatUptime(-1)).toBe('0s');
  });

  test('returns 0s for zero', () => {
    expect(formatUptime(0)).toBe('0s');
  });

  test('handles exactly 1 minute', () => {
    expect(formatUptime(60000)).toBe('1m 0s');
  });

  test('handles exactly 1 hour', () => {
    expect(formatUptime(3600000)).toBe('1h 0m');
  });
});

// ---------------------------------------------------------------------------
// formatMemory
// ---------------------------------------------------------------------------

describe('formatMemory', () => {
  test('displays bytes for small values', () => {
    expect(formatMemory(500)).toBe('500 B');
  });

  test('displays KB for kilobyte range', () => {
    expect(formatMemory(1536)).toBe('1.5 KB');
  });

  test('displays MB for megabyte range', () => {
    expect(formatMemory(10485760)).toBe('10.0 MB');
  });

  test('displays GB for gigabyte range', () => {
    expect(formatMemory(1073741824)).toBe('1.0 GB');
  });

  test('returns 0 B for negative values', () => {
    expect(formatMemory(-1)).toBe('0 B');
  });

  test('returns 0 B for zero', () => {
    expect(formatMemory(0)).toBe('0 B');
  });
});

// ---------------------------------------------------------------------------
// formatState
// ---------------------------------------------------------------------------

describe('formatState', () => {
  test('contains "online" for online state', () => {
    const result = formatState('online');
    expect(result).toContain('online');
  });

  test('contains "crashed" for crashed state', () => {
    const result = formatState('crashed');
    expect(result).toContain('crashed');
  });

  test('contains "stopping" for stopping state', () => {
    const result = formatState('stopping');
    expect(result).toContain('stopping');
  });

  test('contains "errored" for errored state', () => {
    const result = formatState('errored');
    expect(result).toContain('errored');
  });

  test('contains ANSI escape codes', () => {
    const result = formatState('online');
    // Should contain escape sequences for coloring
    expect(result).toContain('\x1b[');
  });
});
