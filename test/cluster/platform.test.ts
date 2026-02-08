// ---------------------------------------------------------------------------
// bunpm – Unit Tests for Cluster Platform Detection
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  detectStrategy,
  isReusePortSupported,
} from '../../src/cluster/platform';

// ---------------------------------------------------------------------------
// detectStrategy
// ---------------------------------------------------------------------------

describe('detectStrategy', () => {
  test('returns "reusePort" when configured as reusePort', () => {
    expect(detectStrategy('reusePort')).toBe('reusePort');
  });

  test('returns "proxy" when configured as proxy', () => {
    expect(detectStrategy('proxy')).toBe('proxy');
  });

  test('returns a valid resolved strategy for "auto"', () => {
    const result = detectStrategy('auto');
    // On any platform, auto must resolve to one of the two concrete strategies
    expect(['reusePort', 'proxy']).toContain(result);
  });

  test('"auto" returns "reusePort" on linux, "proxy" otherwise', () => {
    const result = detectStrategy('auto');
    if (process.platform === 'linux') {
      expect(result).toBe('reusePort');
    } else {
      expect(result).toBe('proxy');
    }
  });
});

// ---------------------------------------------------------------------------
// isReusePortSupported
// ---------------------------------------------------------------------------

describe('isReusePortSupported', () => {
  test('returns a boolean', () => {
    const result = isReusePortSupported();
    expect(typeof result).toBe('boolean');
  });

  test('returns true only on linux', () => {
    const result = isReusePortSupported();
    if (process.platform === 'linux') {
      expect(result).toBe(true);
    } else {
      expect(result).toBe(false);
    }
  });
});
