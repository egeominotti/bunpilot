// ---------------------------------------------------------------------------
// bunpilot – Unit Tests for Global Constants & Defaults
// ---------------------------------------------------------------------------

import { describe, test, expect, afterEach } from 'bun:test';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

import {
  BUNPILOT_HOME,
  SOCKET_PATH,
  PID_FILE,
  DB_PATH,
  LOGS_DIR,
  DAEMON_LOG,
  CONFIG_FILES,
  INTERNAL_PORT_BASE,
  INTERNAL_ENV_KEYS,
  DEFAULT_HEALTH_CHECK,
  DEFAULT_BACKOFF,
  DEFAULT_LOGS,
  DEFAULT_METRICS,
  DEFAULT_CLUSTERING,
  APP_DEFAULTS,
  HEARTBEAT_INTERVAL,
  HEARTBEAT_MISS_THRESHOLD,
  ensureBunpilotHome,
} from '../src/constants';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

describe('Paths', () => {
  test('BUNPILOT_HOME defaults to ~/.bunpilot when env not set', () => {
    // If BUNPILOT_HOME env is not set, it should default to ~/.bunpilot
    // Since constants are evaluated at import time, the value depends on
    // whether the env var was set when the module loaded.
    if (!process.env.BUNPILOT_HOME) {
      expect(BUNPILOT_HOME).toBe(join(homedir(), '.bunpilot'));
    } else {
      // If env is set, it uses that value
      expect(BUNPILOT_HOME).toBe(process.env.BUNPILOT_HOME);
    }
  });

  test('SOCKET_PATH is inside BUNPILOT_HOME', () => {
    // SOCKET_PATH defaults to <BUNPILOT_HOME>/bunpilot.sock unless overridden
    if (!process.env.BUNPILOT_SOCKET) {
      expect(SOCKET_PATH).toBe(join(BUNPILOT_HOME, 'bunpilot.sock'));
      expect(SOCKET_PATH.startsWith(BUNPILOT_HOME)).toBe(true);
    } else {
      expect(SOCKET_PATH).toBe(process.env.BUNPILOT_SOCKET);
    }
  });

  test('PID_FILE is inside BUNPILOT_HOME', () => {
    expect(PID_FILE).toBe(join(BUNPILOT_HOME, 'bunpilot.pid'));
  });

  test('DB_PATH is inside BUNPILOT_HOME', () => {
    expect(DB_PATH).toBe(join(BUNPILOT_HOME, 'bunpilot.db'));
  });

  test('LOGS_DIR is inside BUNPILOT_HOME', () => {
    expect(LOGS_DIR).toBe(join(BUNPILOT_HOME, 'logs'));
  });

  test('DAEMON_LOG is inside BUNPILOT_HOME', () => {
    expect(DAEMON_LOG).toBe(join(BUNPILOT_HOME, 'bunpilot-daemon.log'));
  });
});

// ---------------------------------------------------------------------------
// Config File Names
// ---------------------------------------------------------------------------

describe('CONFIG_FILES', () => {
  test('contains expected config file entries', () => {
    expect(CONFIG_FILES).toContain('bunpilot.config.ts');
    expect(CONFIG_FILES).toContain('bunpilot.config.js');
    expect(CONFIG_FILES).toContain('bunpilot.json');
  });

  test('has exactly 3 entries', () => {
    expect(CONFIG_FILES.length).toBe(3);
  });

  test('TypeScript config is checked first', () => {
    expect(CONFIG_FILES[0]).toBe('bunpilot.config.ts');
  });
});

// ---------------------------------------------------------------------------
// Internal Constants
// ---------------------------------------------------------------------------

describe('INTERNAL_PORT_BASE', () => {
  test('is 40001', () => {
    expect(INTERNAL_PORT_BASE).toBe(40_001);
  });

  test('is a positive integer', () => {
    expect(Number.isInteger(INTERNAL_PORT_BASE)).toBe(true);
    expect(INTERNAL_PORT_BASE).toBeGreaterThan(0);
  });
});

describe('INTERNAL_ENV_KEYS', () => {
  test('is a Set', () => {
    expect(INTERNAL_ENV_KEYS).toBeInstanceOf(Set);
  });

  test('contains BUNPILOT_DAEMON', () => {
    expect(INTERNAL_ENV_KEYS.has('BUNPILOT_DAEMON')).toBe(true);
  });

  test('contains BUNPILOT_CONTROL_SOCKET', () => {
    expect(INTERNAL_ENV_KEYS.has('BUNPILOT_CONTROL_SOCKET')).toBe(true);
  });

  test('contains BUNPILOT_INTERNAL_PORT_BASE', () => {
    expect(INTERNAL_ENV_KEYS.has('BUNPILOT_INTERNAL_PORT_BASE')).toBe(true);
  });

  test('has exactly 3 entries', () => {
    expect(INTERNAL_ENV_KEYS.size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Default Configs
// ---------------------------------------------------------------------------

describe('DEFAULT_HEALTH_CHECK', () => {
  test('is enabled by default', () => {
    expect(DEFAULT_HEALTH_CHECK.enabled).toBe(true);
  });

  test('default path is /health', () => {
    expect(DEFAULT_HEALTH_CHECK.path).toBe('/health');
  });

  test('default interval is 30s', () => {
    expect(DEFAULT_HEALTH_CHECK.interval).toBe(30_000);
  });

  test('default timeout is 5s', () => {
    expect(DEFAULT_HEALTH_CHECK.timeout).toBe(5_000);
  });

  test('default unhealthyThreshold is 3', () => {
    expect(DEFAULT_HEALTH_CHECK.unhealthyThreshold).toBe(3);
  });
});

describe('DEFAULT_BACKOFF', () => {
  test('initial delay is 1s', () => {
    expect(DEFAULT_BACKOFF.initial).toBe(1_000);
  });

  test('multiplier is 2', () => {
    expect(DEFAULT_BACKOFF.multiplier).toBe(2);
  });

  test('max delay is 30s', () => {
    expect(DEFAULT_BACKOFF.max).toBe(30_000);
  });
});

describe('DEFAULT_LOGS', () => {
  test('maxSize is 10MB', () => {
    expect(DEFAULT_LOGS.maxSize).toBe(10 * 1024 * 1024);
  });

  test('maxFiles is 5', () => {
    expect(DEFAULT_LOGS.maxFiles).toBe(5);
  });
});

describe('DEFAULT_METRICS', () => {
  test('is enabled by default', () => {
    expect(DEFAULT_METRICS.enabled).toBe(true);
  });

  test('default httpPort is 9615', () => {
    expect(DEFAULT_METRICS.httpPort).toBe(9_615);
  });

  test('prometheus is disabled by default', () => {
    expect(DEFAULT_METRICS.prometheus).toBe(false);
  });

  test('default collectInterval is 5s', () => {
    expect(DEFAULT_METRICS.collectInterval).toBe(5_000);
  });
});

describe('DEFAULT_CLUSTERING', () => {
  test('is enabled by default', () => {
    expect(DEFAULT_CLUSTERING.enabled).toBe(true);
  });

  test('default strategy is auto', () => {
    expect(DEFAULT_CLUSTERING.strategy).toBe('auto');
  });

  test('rolling restart batchSize is 1', () => {
    expect(DEFAULT_CLUSTERING.rollingRestart.batchSize).toBe(1);
  });

  test('rolling restart batchDelay is 1s', () => {
    expect(DEFAULT_CLUSTERING.rollingRestart.batchDelay).toBe(1_000);
  });
});

// ---------------------------------------------------------------------------
// APP_DEFAULTS
// ---------------------------------------------------------------------------

describe('APP_DEFAULTS', () => {
  test('has all expected fields', () => {
    expect(APP_DEFAULTS).toHaveProperty('maxRestarts');
    expect(APP_DEFAULTS).toHaveProperty('maxRestartWindow');
    expect(APP_DEFAULTS).toHaveProperty('minUptime');
    expect(APP_DEFAULTS).toHaveProperty('killTimeout');
    expect(APP_DEFAULTS).toHaveProperty('shutdownSignal');
    expect(APP_DEFAULTS).toHaveProperty('readyTimeout');
  });

  test('maxRestarts is 15', () => {
    expect(APP_DEFAULTS.maxRestarts).toBe(15);
  });

  test('maxRestartWindow is 15 minutes', () => {
    expect(APP_DEFAULTS.maxRestartWindow).toBe(900_000);
  });

  test('minUptime is 30s', () => {
    expect(APP_DEFAULTS.minUptime).toBe(30_000);
  });

  test('killTimeout is 5s', () => {
    expect(APP_DEFAULTS.killTimeout).toBe(5_000);
  });

  test('shutdownSignal is SIGTERM', () => {
    expect(APP_DEFAULTS.shutdownSignal).toBe('SIGTERM');
  });

  test('readyTimeout is 30s', () => {
    expect(APP_DEFAULTS.readyTimeout).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

describe('Heartbeat', () => {
  test('HEARTBEAT_INTERVAL is 10s', () => {
    expect(HEARTBEAT_INTERVAL).toBe(10_000);
  });

  test('HEARTBEAT_MISS_THRESHOLD is 3', () => {
    expect(HEARTBEAT_MISS_THRESHOLD).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ensureBunpilotHome
// ---------------------------------------------------------------------------

describe('ensureBunpilotHome', () => {
  // We cannot change the module-level BUNPILOT_HOME after import, so we
  // test the function's effect: it creates the BUNPILOT_HOME directory.
  // If BUNPILOT_HOME already exists (e.g. ~/.bunpilot), calling is a no-op.

  test('calling ensureBunpilotHome does not throw', () => {
    expect(() => ensureBunpilotHome()).not.toThrow();
  });

  test('BUNPILOT_HOME directory exists after call', () => {
    ensureBunpilotHome();
    expect(existsSync(BUNPILOT_HOME)).toBe(true);
  });

  test('calling twice does not throw (idempotent)', () => {
    ensureBunpilotHome();
    expect(() => ensureBunpilotHome()).not.toThrow();
  });
});
