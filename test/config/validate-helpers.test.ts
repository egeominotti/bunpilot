// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Validation Helpers
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  isRecord,
  assertString,
  validateBoundedNumber,
  validatePort,
  validateInstances,
  validateShutdownSignal,
  validateEnv,
  validateHealthCheck,
  validateBackoff,
} from '../../src/config/validate-helpers';

// ---------------------------------------------------------------------------
// isRecord
// ---------------------------------------------------------------------------

describe('isRecord', () => {
  test('returns true for plain objects', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  test('returns false for arrays', () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord([1, 2])).toBe(false);
  });

  test('returns false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  test('returns false for primitives', () => {
    expect(isRecord(42)).toBe(false);
    expect(isRecord('str')).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// assertString
// ---------------------------------------------------------------------------

describe('assertString', () => {
  test('does not throw for valid non-empty strings', () => {
    expect(() => assertString('hello', 'field', 'ctx')).not.toThrow();
    expect(() => assertString('a', 'field', 'ctx')).not.toThrow();
  });

  test('throws for empty string', () => {
    expect(() => assertString('', 'name', 'app')).toThrow('"name" must be a non-empty string');
  });

  test('throws for non-string types', () => {
    expect(() => assertString(123, 'field', 'ctx')).toThrow('"field" must be a non-empty string');
    expect(() => assertString(null, 'field', 'ctx')).toThrow('"field" must be a non-empty string');
    expect(() => assertString(undefined, 'f', 'c')).toThrow('"f" must be a non-empty string');
    expect(() => assertString(true, 'f', 'c')).toThrow('"f" must be a non-empty string');
  });
});

// ---------------------------------------------------------------------------
// validateBoundedNumber
// ---------------------------------------------------------------------------

describe('validateBoundedNumber', () => {
  test('returns the value when within range', () => {
    expect(validateBoundedNumber(50, 'field', 'ctx', 0, 100)).toBe(50);
    expect(validateBoundedNumber(0, 'field', 'ctx', 0, 100)).toBe(0);
    expect(validateBoundedNumber(100, 'field', 'ctx', 0, 100)).toBe(100);
  });

  test('throws when below minimum', () => {
    expect(() => validateBoundedNumber(-1, 'field', 'ctx', 0, 100)).toThrow(
      '"field" must be between 0 and 100',
    );
  });

  test('throws when above maximum', () => {
    expect(() => validateBoundedNumber(101, 'field', 'ctx', 0, 100)).toThrow(
      '"field" must be between 0 and 100',
    );
  });

  test('returns undefined for undefined input', () => {
    expect(validateBoundedNumber(undefined, 'field', 'ctx', 0, 100)).toBeUndefined();
  });

  test('returns undefined for null input', () => {
    expect(validateBoundedNumber(null, 'field', 'ctx', 0, 100)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validatePort
// ---------------------------------------------------------------------------

describe('validatePort', () => {
  test('accepts valid ports', () => {
    expect(() => validatePort(80, 'port', 'ctx')).not.toThrow();
    expect(() => validatePort(3000, 'port', 'ctx')).not.toThrow();
    expect(() => validatePort(65535, 'port', 'ctx')).not.toThrow();
    expect(() => validatePort(1, 'port', 'ctx')).not.toThrow();
  });

  test('throws on port 0', () => {
    expect(() => validatePort(0, 'port', 'ctx')).toThrow();
  });

  test('throws on negative port', () => {
    expect(() => validatePort(-1, 'port', 'ctx')).toThrow();
  });

  test('throws on port above 65535', () => {
    expect(() => validatePort(70_000, 'port', 'ctx')).toThrow();
  });

  test('throws on non-number', () => {
    expect(() => validatePort('abc' as unknown, 'port', 'ctx')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateInstances
// ---------------------------------------------------------------------------

describe('validateInstances', () => {
  test('returns numeric value for positive integers', () => {
    expect(validateInstances(4, 'ctx')).toBe(4);
    expect(validateInstances(1, 'ctx')).toBe(1);
  });

  test('returns "max" for string "max"', () => {
    expect(validateInstances('max', 'ctx')).toBe('max');
  });

  test('returns 1 for undefined', () => {
    expect(validateInstances(undefined, 'ctx')).toBe(1);
  });

  test('returns 1 for null', () => {
    expect(validateInstances(null, 'ctx')).toBe(1);
  });

  test('throws on non-positive integer', () => {
    expect(() => validateInstances(-1, 'ctx')).toThrow();
    expect(() => validateInstances(0, 'ctx')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateShutdownSignal
// ---------------------------------------------------------------------------

describe('validateShutdownSignal', () => {
  test('accepts SIGTERM', () => {
    expect(validateShutdownSignal('SIGTERM', 'ctx')).toBe('SIGTERM');
  });

  test('accepts SIGINT', () => {
    expect(validateShutdownSignal('SIGINT', 'ctx')).toBe('SIGINT');
  });

  test('defaults to SIGTERM when undefined', () => {
    expect(validateShutdownSignal(undefined, 'ctx')).toBe('SIGTERM');
  });

  test('defaults to SIGTERM when null', () => {
    expect(validateShutdownSignal(null, 'ctx')).toBe('SIGTERM');
  });

  test('throws on invalid signal', () => {
    expect(() => validateShutdownSignal('SIGKILL', 'ctx')).toThrow(
      '"shutdownSignal" must be "SIGTERM" or "SIGINT"',
    );
  });
});

// ---------------------------------------------------------------------------
// validateEnv
// ---------------------------------------------------------------------------

describe('validateEnv', () => {
  test('returns valid env object', () => {
    const env = { NODE_ENV: 'production', PORT: '3000' };
    expect(validateEnv(env, 'ctx')).toEqual(env);
  });

  test('returns undefined for null', () => {
    expect(validateEnv(null, 'ctx')).toBeUndefined();
  });

  test('returns undefined for undefined', () => {
    expect(validateEnv(undefined, 'ctx')).toBeUndefined();
  });

  test('throws on non-string values in env', () => {
    expect(() => validateEnv({ BAD: 123 }, 'ctx')).toThrow('"env.BAD" must be a string');
  });

  test('throws when env is not a plain object', () => {
    expect(() => validateEnv('not-object', 'ctx')).toThrow('"env" must be a plain object');
    expect(() => validateEnv([1, 2], 'ctx')).toThrow('"env" must be a plain object');
  });
});

// ---------------------------------------------------------------------------
// validateHealthCheck
// ---------------------------------------------------------------------------

describe('validateHealthCheck', () => {
  test('returns defaults when given undefined', () => {
    const result = validateHealthCheck(undefined, 'ctx');
    expect(result.enabled).toBe(true);
    expect(result.path).toBe('/health');
    expect(result.interval).toBe(30_000);
    expect(result.timeout).toBe(5_000);
    expect(result.unhealthyThreshold).toBe(3);
  });

  test('applies custom values', () => {
    const result = validateHealthCheck(
      { enabled: false, path: '/healthz', interval: 10_000, timeout: 2_000, unhealthyThreshold: 5 },
      'ctx',
    );
    expect(result.enabled).toBe(false);
    expect(result.path).toBe('/healthz');
    expect(result.interval).toBe(10_000);
    expect(result.timeout).toBe(2_000);
    expect(result.unhealthyThreshold).toBe(5);
  });

  test('throws when not an object', () => {
    expect(() => validateHealthCheck('bad', 'ctx')).toThrow('"healthCheck" must be an object');
  });
});

// ---------------------------------------------------------------------------
// validateBackoff
// ---------------------------------------------------------------------------

describe('validateBackoff', () => {
  test('returns defaults when given undefined', () => {
    const result = validateBackoff(undefined, 'ctx');
    expect(result.initial).toBe(1_000);
    expect(result.multiplier).toBe(2);
    expect(result.max).toBe(30_000);
  });

  test('applies custom values', () => {
    const result = validateBackoff({ initial: 500, multiplier: 3, max: 60_000 }, 'ctx');
    expect(result.initial).toBe(500);
    expect(result.multiplier).toBe(3);
    expect(result.max).toBe(60_000);
  });

  test('throws when not an object', () => {
    expect(() => validateBackoff('bad', 'ctx')).toThrow('"backoff" must be an object');
  });

  test('throws when values are out of range', () => {
    expect(() => validateBackoff({ initial: 50 }, 'ctx')).toThrow(
      '"backoff.initial" must be between 100 and 300000',
    );
    expect(() => validateBackoff({ multiplier: 20 }, 'ctx')).toThrow(
      '"backoff.multiplier" must be between 1 and 10',
    );
  });
});
