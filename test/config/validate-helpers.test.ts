// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Validation Helpers
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  isRecord,
  assertString,
  assertNumber,
  assertPositiveInt,
  validateBoundedNumber,
  validatePort,
  validateInstances,
  validateShutdownSignal,
  validateEnv,
  validateHealthCheck,
  validateBackoff,
  validateLogs,
  validateMetrics,
  validateClustering,
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

// ---------------------------------------------------------------------------
// assertNumber
// ---------------------------------------------------------------------------

describe('assertNumber', () => {
  test('does not throw for valid finite numbers', () => {
    expect(() => assertNumber(0, 'field', 'ctx')).not.toThrow();
    expect(() => assertNumber(42, 'field', 'ctx')).not.toThrow();
    expect(() => assertNumber(-3.14, 'field', 'ctx')).not.toThrow();
    expect(() => assertNumber(Number.MAX_SAFE_INTEGER, 'field', 'ctx')).not.toThrow();
  });

  test('throws for NaN', () => {
    expect(() => assertNumber(NaN, 'field', 'ctx')).toThrow('"field" must be a finite number');
  });

  test('throws for Infinity', () => {
    expect(() => assertNumber(Infinity, 'field', 'ctx')).toThrow('"field" must be a finite number');
    expect(() => assertNumber(-Infinity, 'field', 'ctx')).toThrow(
      '"field" must be a finite number',
    );
  });

  test('throws for non-number types', () => {
    expect(() => assertNumber('42', 'field', 'ctx')).toThrow('"field" must be a finite number');
    expect(() => assertNumber(null, 'field', 'ctx')).toThrow('"field" must be a finite number');
    expect(() => assertNumber(undefined, 'field', 'ctx')).toThrow(
      '"field" must be a finite number',
    );
    expect(() => assertNumber(true, 'field', 'ctx')).toThrow('"field" must be a finite number');
    expect(() => assertNumber({}, 'field', 'ctx')).toThrow('"field" must be a finite number');
    expect(() => assertNumber([], 'field', 'ctx')).toThrow('"field" must be a finite number');
  });

  test('includes context and field in error message', () => {
    expect(() => assertNumber('bad', 'timeout', 'app:web')).toThrow(
      '[app:web] "timeout" must be a finite number',
    );
  });
});

// ---------------------------------------------------------------------------
// assertPositiveInt
// ---------------------------------------------------------------------------

describe('assertPositiveInt', () => {
  test('does not throw for valid positive integers', () => {
    expect(() => assertPositiveInt(1, 'field', 'ctx')).not.toThrow();
    expect(() => assertPositiveInt(100, 'field', 'ctx')).not.toThrow();
    expect(() => assertPositiveInt(Number.MAX_SAFE_INTEGER, 'field', 'ctx')).not.toThrow();
  });

  test('throws for zero', () => {
    expect(() => assertPositiveInt(0, 'field', 'ctx')).toThrow(
      '"field" must be a positive integer',
    );
  });

  test('throws for negative integers', () => {
    expect(() => assertPositiveInt(-1, 'field', 'ctx')).toThrow(
      '"field" must be a positive integer',
    );
    expect(() => assertPositiveInt(-100, 'field', 'ctx')).toThrow(
      '"field" must be a positive integer',
    );
  });

  test('throws for floating point numbers', () => {
    expect(() => assertPositiveInt(1.5, 'field', 'ctx')).toThrow(
      '"field" must be a positive integer',
    );
    expect(() => assertPositiveInt(3.14, 'field', 'ctx')).toThrow(
      '"field" must be a positive integer',
    );
  });

  test('throws for non-number types (delegates to assertNumber)', () => {
    expect(() => assertPositiveInt('5', 'field', 'ctx')).toThrow(
      '"field" must be a finite number',
    );
    expect(() => assertPositiveInt(null, 'field', 'ctx')).toThrow(
      '"field" must be a finite number',
    );
    expect(() => assertPositiveInt(undefined, 'field', 'ctx')).toThrow(
      '"field" must be a finite number',
    );
  });

  test('throws for NaN and Infinity (delegates to assertNumber)', () => {
    expect(() => assertPositiveInt(NaN, 'field', 'ctx')).toThrow(
      '"field" must be a finite number',
    );
    expect(() => assertPositiveInt(Infinity, 'field', 'ctx')).toThrow(
      '"field" must be a finite number',
    );
  });

  test('includes context and field in error message', () => {
    expect(() => assertPositiveInt(0, 'instances', 'app:api')).toThrow(
      '[app:api] "instances" must be a positive integer',
    );
  });
});

// ---------------------------------------------------------------------------
// validateLogs
// ---------------------------------------------------------------------------

describe('validateLogs', () => {
  test('returns defaults when given undefined', () => {
    const result = validateLogs(undefined, 'ctx');
    expect(result.maxSize).toBe(10 * 1024 * 1024);
    expect(result.maxFiles).toBe(5);
    expect(result.outFile).toBeUndefined();
    expect(result.errFile).toBeUndefined();
  });

  test('returns defaults when given null', () => {
    const result = validateLogs(null, 'ctx');
    expect(result.maxSize).toBe(10 * 1024 * 1024);
    expect(result.maxFiles).toBe(5);
  });

  test('applies custom maxSize and maxFiles', () => {
    const result = validateLogs({ maxSize: 2048, maxFiles: 10 }, 'ctx');
    expect(result.maxSize).toBe(2048);
    expect(result.maxFiles).toBe(10);
  });

  test('accepts outFile and errFile strings', () => {
    const result = validateLogs(
      { outFile: '/var/log/app-out.log', errFile: '/var/log/app-err.log' },
      'ctx',
    );
    expect(result.outFile).toBe('/var/log/app-out.log');
    expect(result.errFile).toBe('/var/log/app-err.log');
  });

  test('ignores empty outFile and errFile strings', () => {
    const result = validateLogs({ outFile: '', errFile: '' }, 'ctx');
    expect(result.outFile).toBeUndefined();
    expect(result.errFile).toBeUndefined();
  });

  test('ignores non-string outFile and errFile', () => {
    const result = validateLogs({ outFile: 123, errFile: true }, 'ctx');
    expect(result.outFile).toBeUndefined();
    expect(result.errFile).toBeUndefined();
  });

  test('throws when not an object', () => {
    expect(() => validateLogs('bad', 'ctx')).toThrow('"logs" must be an object');
    expect(() => validateLogs(42, 'ctx')).toThrow('"logs" must be an object');
    expect(() => validateLogs([1, 2], 'ctx')).toThrow('"logs" must be an object');
  });

  test('throws when maxSize is below minimum', () => {
    expect(() => validateLogs({ maxSize: 500 }, 'ctx')).toThrow(
      '"logs.maxSize" must be between 1024 and 1073741824',
    );
  });

  test('throws when maxSize is above maximum', () => {
    expect(() => validateLogs({ maxSize: 2_000_000_000 }, 'ctx')).toThrow(
      '"logs.maxSize" must be between 1024 and 1073741824',
    );
  });

  test('throws when maxFiles is below minimum', () => {
    expect(() => validateLogs({ maxFiles: 0 }, 'ctx')).toThrow(
      '"logs.maxFiles" must be between 1 and 100',
    );
  });

  test('throws when maxFiles is above maximum', () => {
    expect(() => validateLogs({ maxFiles: 101 }, 'ctx')).toThrow(
      '"logs.maxFiles" must be between 1 and 100',
    );
  });

  test('uses defaults for omitted numeric fields', () => {
    const result = validateLogs({}, 'ctx');
    expect(result.maxSize).toBe(10 * 1024 * 1024);
    expect(result.maxFiles).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// validateMetrics
// ---------------------------------------------------------------------------

describe('validateMetrics', () => {
  test('returns defaults when given undefined', () => {
    const result = validateMetrics(undefined, 'ctx');
    expect(result.enabled).toBe(true);
    expect(result.httpPort).toBe(9_615);
    expect(result.prometheus).toBe(false);
    expect(result.collectInterval).toBe(5_000);
  });

  test('returns defaults when given null', () => {
    const result = validateMetrics(null, 'ctx');
    expect(result.enabled).toBe(true);
    expect(result.httpPort).toBe(9_615);
    expect(result.prometheus).toBe(false);
    expect(result.collectInterval).toBe(5_000);
  });

  test('applies custom values', () => {
    const result = validateMetrics(
      { enabled: false, httpPort: 8080, prometheus: true, collectInterval: 10_000 },
      'ctx',
    );
    expect(result.enabled).toBe(false);
    expect(result.httpPort).toBe(8080);
    expect(result.prometheus).toBe(true);
    expect(result.collectInterval).toBe(10_000);
  });

  test('uses default enabled when not a boolean', () => {
    const result = validateMetrics({ enabled: 'yes' }, 'ctx');
    expect(result.enabled).toBe(true);
  });

  test('uses default prometheus when not a boolean', () => {
    const result = validateMetrics({ prometheus: 'yes' }, 'ctx');
    expect(result.prometheus).toBe(false);
  });

  test('uses default httpPort when not provided', () => {
    const result = validateMetrics({}, 'ctx');
    expect(result.httpPort).toBe(9_615);
  });

  test('throws when not an object', () => {
    expect(() => validateMetrics('bad', 'ctx')).toThrow('"metrics" must be an object');
    expect(() => validateMetrics(42, 'ctx')).toThrow('"metrics" must be an object');
    expect(() => validateMetrics([1, 2], 'ctx')).toThrow('"metrics" must be an object');
  });

  test('throws when httpPort is invalid', () => {
    expect(() => validateMetrics({ httpPort: 0 }, 'ctx')).toThrow();
    expect(() => validateMetrics({ httpPort: 70_000 }, 'ctx')).toThrow();
    expect(() => validateMetrics({ httpPort: -1 }, 'ctx')).toThrow();
  });

  test('throws when httpPort is not a number', () => {
    expect(() => validateMetrics({ httpPort: 'abc' }, 'ctx')).toThrow();
  });

  test('throws when collectInterval is out of range', () => {
    expect(() => validateMetrics({ collectInterval: 500 }, 'ctx')).toThrow(
      '"metrics.collectInterval" must be between 1000 and 300000',
    );
    expect(() => validateMetrics({ collectInterval: 400_000 }, 'ctx')).toThrow(
      '"metrics.collectInterval" must be between 1000 and 300000',
    );
  });

  test('uses defaults for omitted fields in empty object', () => {
    const result = validateMetrics({}, 'ctx');
    expect(result.enabled).toBe(true);
    expect(result.prometheus).toBe(false);
    expect(result.collectInterval).toBe(5_000);
    expect(result.httpPort).toBe(9_615);
  });
});

// ---------------------------------------------------------------------------
// validateClustering
// ---------------------------------------------------------------------------

describe('validateClustering', () => {
  test('returns defaults when given undefined', () => {
    const result = validateClustering(undefined, 'ctx');
    expect(result.enabled).toBe(true);
    expect(result.strategy).toBe('auto');
    expect(result.rollingRestart).toEqual({ batchSize: 1, batchDelay: 1_000 });
  });

  test('returns defaults when given null', () => {
    const result = validateClustering(null, 'ctx');
    expect(result.enabled).toBe(true);
    expect(result.strategy).toBe('auto');
    expect(result.rollingRestart).toEqual({ batchSize: 1, batchDelay: 1_000 });
  });

  test('applies custom values', () => {
    const result = validateClustering(
      {
        enabled: false,
        strategy: 'proxy',
        rollingRestart: { batchSize: 5, batchDelay: 2_000 },
      },
      'ctx',
    );
    expect(result.enabled).toBe(false);
    expect(result.strategy).toBe('proxy');
    expect(result.rollingRestart.batchSize).toBe(5);
    expect(result.rollingRestart.batchDelay).toBe(2_000);
  });

  test('accepts all valid strategies', () => {
    expect(validateClustering({ strategy: 'reusePort' }, 'ctx').strategy).toBe('reusePort');
    expect(validateClustering({ strategy: 'proxy' }, 'ctx').strategy).toBe('proxy');
    expect(validateClustering({ strategy: 'auto' }, 'ctx').strategy).toBe('auto');
  });

  test('throws for invalid strategy string', () => {
    expect(() => validateClustering({ strategy: 'invalid' }, 'ctx')).toThrow(
      '"clustering.strategy" must be one of',
    );
  });

  test('throws for non-string strategy value', () => {
    expect(() => validateClustering({ strategy: 42 }, 'ctx')).toThrow(
      '"clustering.strategy" must be one of',
    );
  });

  test('uses default enabled when not a boolean', () => {
    const result = validateClustering({ enabled: 'yes' }, 'ctx');
    expect(result.enabled).toBe(true);
  });

  test('throws when not an object', () => {
    expect(() => validateClustering('bad', 'ctx')).toThrow('"clustering" must be an object');
    expect(() => validateClustering(42, 'ctx')).toThrow('"clustering" must be an object');
    expect(() => validateClustering([1, 2], 'ctx')).toThrow('"clustering" must be an object');
  });

  test('uses default rollingRestart when not provided', () => {
    const result = validateClustering({}, 'ctx');
    expect(result.rollingRestart).toEqual({ batchSize: 1, batchDelay: 1_000 });
  });

  test('uses default rollingRestart when not an object', () => {
    const result = validateClustering({ rollingRestart: 'bad' }, 'ctx');
    expect(result.rollingRestart).toEqual({ batchSize: 1, batchDelay: 1_000 });
  });

  test('throws when rollingRestart.batchSize is out of range', () => {
    expect(() =>
      validateClustering({ rollingRestart: { batchSize: 0 } }, 'ctx'),
    ).toThrow('"clustering.rollingRestart.batchSize" must be between 1 and 100');
    expect(() =>
      validateClustering({ rollingRestart: { batchSize: 101 } }, 'ctx'),
    ).toThrow('"clustering.rollingRestart.batchSize" must be between 1 and 100');
  });

  test('throws when rollingRestart.batchDelay is out of range', () => {
    expect(() =>
      validateClustering({ rollingRestart: { batchDelay: -1 } }, 'ctx'),
    ).toThrow('"clustering.rollingRestart.batchDelay" must be between 0 and 300000');
    expect(() =>
      validateClustering({ rollingRestart: { batchDelay: 400_000 } }, 'ctx'),
    ).toThrow('"clustering.rollingRestart.batchDelay" must be between 0 and 300000');
  });

  test('uses defaults for omitted rollingRestart fields', () => {
    const result = validateClustering({ rollingRestart: {} }, 'ctx');
    expect(result.rollingRestart.batchSize).toBe(1);
    expect(result.rollingRestart.batchDelay).toBe(1_000);
  });

  test('accepts batchDelay of 0', () => {
    const result = validateClustering({ rollingRestart: { batchDelay: 0 } }, 'ctx');
    expect(result.rollingRestart.batchDelay).toBe(0);
  });

  // Bug 1: Shallow spread of DEFAULT_CLUSTERING leaks shared nested reference
  test('does not mutate DEFAULT_CLUSTERING when returning defaults', () => {
    // First call returns defaults (no rollingRestart provided)
    const result1 = validateClustering(undefined, 'ctx');
    // Second call returns defaults too
    const result2 = validateClustering(undefined, 'ctx');

    // Mutate the rollingRestart on the first result
    result1.rollingRestart.batchSize = 99;
    result1.rollingRestart.batchDelay = 99_999;

    // The second result should NOT be affected
    expect(result2.rollingRestart.batchSize).toBe(1);
    expect(result2.rollingRestart.batchDelay).toBe(1_000);

    // Also verify a fresh call still returns correct defaults
    const result3 = validateClustering(undefined, 'ctx');
    expect(result3.rollingRestart.batchSize).toBe(1);
    expect(result3.rollingRestart.batchDelay).toBe(1_000);
  });

  // Bug 5: validateClustering silently accepts invalid strategy strings
  test('throws for invalid strategy strings', () => {
    expect(() => validateClustering({ strategy: 'invalid' }, 'ctx')).toThrow(
      '"clustering.strategy" must be one of',
    );
  });

  test('throws for non-string strategy values', () => {
    expect(() => validateClustering({ strategy: 42 }, 'ctx')).toThrow(
      '"clustering.strategy" must be one of',
    );
  });
});

// ---------------------------------------------------------------------------
// validateBoundedNumber – integer mode (Bug 9)
// ---------------------------------------------------------------------------

describe('validateBoundedNumber integer mode', () => {
  test('accepts integers when integer flag is true', () => {
    expect(validateBoundedNumber(5, 'field', 'ctx', 0, 100, true)).toBe(5);
    expect(validateBoundedNumber(0, 'field', 'ctx', 0, 100, true)).toBe(0);
    expect(validateBoundedNumber(100, 'field', 'ctx', 0, 100, true)).toBe(100);
  });

  test('rejects floats when integer flag is true', () => {
    expect(() => validateBoundedNumber(3.7, 'field', 'ctx', 0, 100, true)).toThrow(
      '"field" must be an integer',
    );
    expect(() => validateBoundedNumber(2.5, 'field', 'ctx', 0, 100, true)).toThrow(
      '"field" must be an integer',
    );
  });

  test('still allows floats when integer flag is false or undefined', () => {
    expect(validateBoundedNumber(3.7, 'field', 'ctx', 0, 100)).toBe(3.7);
    expect(validateBoundedNumber(3.7, 'field', 'ctx', 0, 100, false)).toBe(3.7);
  });
});

// ---------------------------------------------------------------------------
// validateHealthCheck cross-field: timeout >= interval (Bug 10)
// ---------------------------------------------------------------------------

describe('validateHealthCheck cross-field validation', () => {
  test('throws when timeout >= interval', () => {
    expect(() =>
      validateHealthCheck({ timeout: 30_000, interval: 30_000 }, 'ctx'),
    ).toThrow('timeout');
    expect(() =>
      validateHealthCheck({ timeout: 40_000, interval: 30_000 }, 'ctx'),
    ).toThrow('timeout');
  });

  test('accepts when timeout < interval', () => {
    const result = validateHealthCheck({ timeout: 5_000, interval: 30_000 }, 'ctx');
    expect(result.timeout).toBe(5_000);
    expect(result.interval).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// validateBackoff cross-field: initial > max (Bug 11)
// ---------------------------------------------------------------------------

describe('validateBackoff cross-field validation', () => {
  test('throws when initial > max', () => {
    expect(() =>
      validateBackoff({ initial: 60_000, max: 30_000 }, 'ctx'),
    ).toThrow('initial');
  });

  test('accepts when initial <= max', () => {
    const result = validateBackoff({ initial: 1_000, max: 30_000 }, 'ctx');
    expect(result.initial).toBe(1_000);
    expect(result.max).toBe(30_000);
  });

  test('accepts when initial equals max', () => {
    const result = validateBackoff({ initial: 30_000, max: 30_000 }, 'ctx');
    expect(result.initial).toBe(30_000);
    expect(result.max).toBe(30_000);
  });
});
