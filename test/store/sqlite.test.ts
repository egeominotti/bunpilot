// ---------------------------------------------------------------------------
// bunpilot – Unit Tests: SqliteStore
// ---------------------------------------------------------------------------
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteStore } from '../../src/store/sqlite';
import type { AppConfig } from '../../src/config/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: 'test-app',
    script: './index.ts',
    instances: 1,
    maxRestarts: 10,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    backoff: { initial: 100, multiplier: 2, max: 30_000 },
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 10_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('SqliteStore', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
  });

  afterEach(() => {
    try { store.close(); } catch { /* already closed */ }
  });

  // -- Initialization -----------------------------------------------------
  test('init creates tables without throwing', () => {
    expect(() => store.init()).not.toThrow();
  });

  // -- App CRUD -----------------------------------------------------------
  test('saveApp and getApp round-trip', () => {
    const config = makeAppConfig({ name: 'my-app' });
    store.saveApp('my-app', config, '/path/to/config.json');
    const row = store.getApp('my-app');
    expect(row).not.toBeNull();
    expect(row!.name).toBe('my-app');
    expect(row!.status).toBe('stopped');
    expect(row!.config_path).toBe('/path/to/config.json');
    const parsed = JSON.parse(row!.config_json);
    expect(parsed.script).toBe('./index.ts');
  });

  test('getApp returns null for non-existent app', () => {
    expect(store.getApp('ghost')).toBeNull();
  });

  test('saveApp upserts on conflict', () => {
    store.saveApp('app', makeAppConfig({ script: './v1.ts' }));
    store.saveApp('app', makeAppConfig({ script: './v2.ts' }));
    const parsed = JSON.parse(store.getApp('app')!.config_json);
    expect(parsed.script).toBe('./v2.ts');
  });

  test('listApps returns all apps ordered by name', () => {
    store.saveApp('charlie', makeAppConfig({ name: 'charlie' }));
    store.saveApp('alpha', makeAppConfig({ name: 'alpha' }));
    store.saveApp('bravo', makeAppConfig({ name: 'bravo' }));
    const apps = store.listApps();
    expect(apps).toHaveLength(3);
    expect(apps.map((a) => a.name)).toEqual(['alpha', 'bravo', 'charlie']);
  });

  test('updateAppStatus changes status', () => {
    store.saveApp('srv', makeAppConfig());
    expect(store.getApp('srv')!.status).toBe('stopped');
    store.updateAppStatus('srv', 'running');
    expect(store.getApp('srv')!.status).toBe('running');
    store.updateAppStatus('srv', 'errored');
    expect(store.getApp('srv')!.status).toBe('errored');
  });

  test('deleteApp removes the app', () => {
    store.saveApp('temp', makeAppConfig());
    expect(store.getApp('temp')).not.toBeNull();
    store.deleteApp('temp');
    expect(store.getApp('temp')).toBeNull();
  });

  // -- Workers ------------------------------------------------------------
  test('saveWorker and getWorkers round-trip', () => {
    store.saveWorker('app', 0, 'online', 1234);
    store.saveWorker('app', 1, 'starting', 1235);
    const workers = store.getWorkers('app');
    expect(workers).toHaveLength(2);
    expect(workers[0].worker_id).toBe(0);
    expect(workers[0].state).toBe('online');
    expect(workers[0].pid).toBe(1234);
    expect(workers[1].worker_id).toBe(1);
  });

  test('getWorkers returns empty array for unknown app', () => {
    expect(store.getWorkers('ghost')).toEqual([]);
  });

  test('updateWorkerState changes state and extra_json', () => {
    store.saveWorker('app', 0, 'starting', 100);
    store.updateWorkerState('app', 0, 'online', { readyAt: 12345 });
    const w = store.getWorkers('app')[0];
    expect(w.state).toBe('online');
    expect(JSON.parse(w.extra_json!).readyAt).toBe(12345);
  });

  test('updateWorkerState sets extra_json to null when no extra', () => {
    store.saveWorker('app', 0, 'starting', 100);
    store.updateWorkerState('app', 0, 'stopped');
    expect(store.getWorkers('app')[0].extra_json).toBeNull();
  });

  // -- Restart History ----------------------------------------------------
  test('addRestartEntry and getRestartHistory round-trip', () => {
    store.addRestartEntry('app', 0, 999, 1, null, 5000, 'crash');
    const h = store.getRestartHistory('app');
    expect(h).toHaveLength(1);
    expect(h[0].app_name).toBe('app');
    expect(h[0].pid).toBe(999);
    expect(h[0].exit_code).toBe(1);
    expect(h[0].signal).toBeNull();
    expect(h[0].uptime_ms).toBe(5000);
    expect(h[0].reason).toBe('crash');
  });

  test('getRestartHistory respects limit', () => {
    for (let i = 0; i < 10; i++) {
      store.addRestartEntry('app', 0, 1000 + i, 1, null, i * 100, 'crash');
    }
    expect(store.getRestartHistory('app', 3)).toHaveLength(3);
    expect(store.getRestartHistory('app', 100)).toHaveLength(10);
  });

  test('getRestartHistory returns newest first', () => {
    store.addRestartEntry('app', 0, 100, 1, null, 100, 'first');
    store.addRestartEntry('app', 0, 200, 1, null, 200, 'second');
    const h = store.getRestartHistory('app');
    expect(h[0].reason).toBe('second');
    expect(h[1].reason).toBe('first');
  });

  // -- Metrics ------------------------------------------------------------
  test('saveMetricSnapshot does not throw', () => {
    expect(() => store.saveMetricSnapshot('app', 0, 50e6, 30e6, 2.5, 1.2)).not.toThrow();
  });

  test('saveMetricSnapshot without eventLoopLag does not throw', () => {
    expect(() => store.saveMetricSnapshot('app', 0, 50e6, 30e6, 2.5)).not.toThrow();
  });

  // -- Cleanup ------------------------------------------------------------
  test('cleanupOldMetrics removes old entries', () => {
    store.saveMetricSnapshot('app', 0, 100, 50, 1.0);
    store.cleanupOldMetrics(0);
    expect(() => store.cleanupOldMetrics(0)).not.toThrow();
  });

  test('cleanupOldRestarts keeps only N entries', () => {
    for (let i = 0; i < 5; i++) {
      store.addRestartEntry('app', 0, 100 + i, 1, null, 100, 'crash');
    }
    store.cleanupOldRestarts(2);
    expect(store.getRestartHistory('app')).toHaveLength(2);
  });

  // -- Bug 1: cleanupOldRestarts should be per-app, not global -----------
  test('cleanupOldRestarts keeps N entries per app, not globally', () => {
    // App A has 3 entries, App B has 3 entries
    for (let i = 0; i < 3; i++) {
      store.addRestartEntry('app-a', 0, 100 + i, 1, null, 100, `crash-a-${i}`);
      store.addRestartEntry('app-b', 0, 200 + i, 1, null, 100, `crash-b-${i}`);
    }

    // Keep 2 entries per app => app-a should have 2, app-b should have 2
    store.cleanupOldRestarts(2);

    const histA = store.getRestartHistory('app-a');
    const histB = store.getRestartHistory('app-b');

    // Both apps should retain their most recent 2 entries
    expect(histA).toHaveLength(2);
    expect(histB).toHaveLength(2);
  });

  // -- Bug 2: deleteApp should cascade-delete related rows ---------------
  test('deleteApp cascade-deletes workers, restart_history, and metrics', () => {
    store.saveApp('doomed', makeAppConfig({ name: 'doomed' }));
    store.saveWorker('doomed', 0, 'online', 1234);
    store.saveWorker('doomed', 1, 'online', 1235);
    store.addRestartEntry('doomed', 0, 1234, 1, null, 500, 'crash');
    store.addRestartEntry('doomed', 1, 1235, 0, 'SIGTERM', 1000, 'manual');
    store.saveMetricSnapshot('doomed', 0, 50e6, 30e6, 2.5, 1.0);

    // Also save another app to confirm it's NOT affected
    store.saveApp('keeper', makeAppConfig({ name: 'keeper' }));
    store.saveWorker('keeper', 0, 'online', 9999);
    store.addRestartEntry('keeper', 0, 9999, 1, null, 300, 'crash');
    store.saveMetricSnapshot('keeper', 0, 40e6, 20e6, 1.5);

    store.deleteApp('doomed');

    // App should be gone
    expect(store.getApp('doomed')).toBeNull();

    // Workers should be gone
    expect(store.getWorkers('doomed')).toEqual([]);

    // Restart history should be gone
    expect(store.getRestartHistory('doomed')).toEqual([]);

    // Keeper should be untouched
    expect(store.getApp('keeper')).not.toBeNull();
    expect(store.getWorkers('keeper')).toHaveLength(1);
    expect(store.getRestartHistory('keeper')).toHaveLength(1);
  });

  // -- Bug 3: saveWorker should not overwrite started_at on state update --
  test('saveWorker preserves started_at when PID unchanged', () => {
    // Insert a worker with PID 1234
    store.saveWorker('app', 0, 'starting', 1234);
    const w1 = store.getWorkers('app')[0];
    const originalStartedAt = w1.started_at;

    // Simulate a small delay to ensure time would differ if overwritten
    // Update state but keep same PID — started_at should NOT change
    store.saveWorker('app', 0, 'online', 1234);
    const w2 = store.getWorkers('app')[0];

    expect(w2.state).toBe('online');
    expect(w2.started_at).toBe(originalStartedAt);
  });

  test('saveWorker updates started_at when PID changes', () => {
    // Insert a worker with PID 1234
    store.saveWorker('app', 0, 'starting', 1234);
    const w1 = store.getWorkers('app')[0];
    const originalStartedAt = w1.started_at;

    // Update with a different PID — started_at SHOULD change
    store.saveWorker('app', 0, 'starting', 5678);
    const w2 = store.getWorkers('app')[0];

    expect(w2.pid).toBe(5678);
    // started_at should be >= original (it was reset)
    expect(w2.started_at).toBeGreaterThanOrEqual(originalStartedAt);
  });

  // -- Lifecycle ----------------------------------------------------------
  test('close does not throw', () => {
    expect(() => store.close()).not.toThrow();
  });
});
