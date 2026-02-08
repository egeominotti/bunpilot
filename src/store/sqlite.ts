// ---------------------------------------------------------------------------
// bunpilot – SQLite Store: persistent state for apps, workers, and metrics
// ---------------------------------------------------------------------------

import { Database } from 'bun:sqlite';
import { DB_PATH } from '../constants';
import type { AppConfig } from '../config/types';

// ---------------------------------------------------------------------------
// Record types returned by queries
// ---------------------------------------------------------------------------

export interface WorkerRecord {
  app_name: string;
  worker_id: number;
  state: string;
  pid: number | null;
  started_at: number;
  extra_json: string | null;
}

export interface RestartRecord {
  id: number;
  app_name: string;
  worker_id: number;
  pid: number;
  exit_code: number | null;
  signal: string | null;
  uptime_ms: number;
  reason: string;
  created_at: number;
}

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

export class SqliteStore {
  private readonly db: Database;

  constructor(dbPath: string = DB_PATH) {
    this.db = new Database(dbPath, { create: true });
    this.init();
  }

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /** Create tables and set performance pragmas. */
  init(): void {
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA cache_size = -8000'); // 8 MB
    this.db.exec('PRAGMA busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        name        TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'stopped',
        config_path TEXT,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        app_name    TEXT    NOT NULL,
        worker_id   INTEGER NOT NULL,
        state       TEXT    NOT NULL DEFAULT 'stopped',
        pid         INTEGER,
        started_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000),
        extra_json  TEXT,
        PRIMARY KEY (app_name, worker_id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS restart_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name    TEXT    NOT NULL,
        worker_id   INTEGER NOT NULL,
        pid         INTEGER NOT NULL,
        exit_code   INTEGER,
        signal      TEXT,
        uptime_ms   INTEGER NOT NULL,
        reason      TEXT    NOT NULL,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metrics (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        app_name     TEXT    NOT NULL,
        worker_id    INTEGER NOT NULL,
        rss          INTEGER NOT NULL,
        heap_used    INTEGER NOT NULL,
        cpu_percent  REAL    NOT NULL,
        event_loop_lag REAL,
        created_at   INTEGER NOT NULL DEFAULT (unixepoch('now') * 1000)
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_restart_app
        ON restart_history (app_name, created_at DESC)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_metrics_app
        ON metrics (app_name, created_at DESC)
    `);
  }

  // -------------------------------------------------------------------------
  // App methods
  // -------------------------------------------------------------------------

  saveApp(name: string, config: AppConfig, configPath?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO apps (name, config_json, status, config_path)
      VALUES (?1, ?2, 'stopped', ?3)
      ON CONFLICT(name) DO UPDATE SET
        config_json = excluded.config_json,
        config_path = excluded.config_path,
        updated_at  = unixepoch('now') * 1000
    `);
    stmt.run(name, JSON.stringify(config), configPath ?? null);
  }

  getApp(
    name: string,
  ): { name: string; config_json: string; status: string; config_path: string | null } | null {
    const stmt = this.db.prepare(
      'SELECT name, config_json, status, config_path FROM apps WHERE name = ?1',
    );
    return stmt.get(name) as {
      name: string;
      config_json: string;
      status: string;
      config_path: string | null;
    } | null;
  }

  listApps(): Array<{ name: string; config_json: string; status: string }> {
    const stmt = this.db.prepare('SELECT name, config_json, status FROM apps ORDER BY name');
    return stmt.all() as Array<{ name: string; config_json: string; status: string }>;
  }

  updateAppStatus(name: string, status: string): void {
    const stmt = this.db.prepare(
      "UPDATE apps SET status = ?1, updated_at = unixepoch('now') * 1000 WHERE name = ?2",
    );
    stmt.run(status, name);
  }

  deleteApp(name: string): void {
    const stmt = this.db.prepare('DELETE FROM apps WHERE name = ?1');
    stmt.run(name);
  }

  // -------------------------------------------------------------------------
  // Worker methods
  // -------------------------------------------------------------------------

  saveWorker(appName: string, workerId: number, state: string, pid?: number): void {
    const stmt = this.db.prepare(`
      INSERT INTO workers (app_name, worker_id, state, pid)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(app_name, worker_id) DO UPDATE SET
        state = excluded.state,
        pid   = excluded.pid,
        started_at = unixepoch('now') * 1000
    `);
    stmt.run(appName, workerId, state, pid ?? null);
  }

  updateWorkerState(appName: string, workerId: number, state: string, extra?: object): void {
    const stmt = this.db.prepare(
      'UPDATE workers SET state = ?1, extra_json = ?2 WHERE app_name = ?3 AND worker_id = ?4',
    );
    stmt.run(state, extra ? JSON.stringify(extra) : null, appName, workerId);
  }

  getWorkers(appName: string): WorkerRecord[] {
    const stmt = this.db.prepare(
      'SELECT app_name, worker_id, state, pid, started_at, extra_json FROM workers WHERE app_name = ?1 ORDER BY worker_id',
    );
    return stmt.all(appName) as WorkerRecord[];
  }

  // -------------------------------------------------------------------------
  // Restart history
  // -------------------------------------------------------------------------

  addRestartEntry(
    appName: string,
    workerId: number,
    pid: number,
    exitCode: number | null,
    signal: string | null,
    uptimeMs: number,
    reason: string,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO restart_history (app_name, worker_id, pid, exit_code, signal, uptime_ms, reason)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `);
    stmt.run(appName, workerId, pid, exitCode, signal, uptimeMs, reason);
  }

  getRestartHistory(appName: string, limit: number = 50): RestartRecord[] {
    const stmt = this.db.prepare(
      'SELECT * FROM restart_history WHERE app_name = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2',
    );
    return stmt.all(appName, limit) as RestartRecord[];
  }

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------

  saveMetricSnapshot(
    appName: string,
    workerId: number,
    rss: number,
    heapUsed: number,
    cpuPercent: number,
    eventLoopLag?: number,
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO metrics (app_name, worker_id, rss, heap_used, cpu_percent, event_loop_lag)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `);
    stmt.run(appName, workerId, rss, heapUsed, cpuPercent, eventLoopLag ?? null);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  cleanupOldMetrics(retentionMs: number): void {
    const cutoff = Date.now() - retentionMs;
    const stmt = this.db.prepare('DELETE FROM metrics WHERE created_at < ?1');
    stmt.run(cutoff);
  }

  cleanupOldRestarts(maxEntries: number): void {
    const stmt = this.db.prepare(`
      DELETE FROM restart_history
      WHERE id NOT IN (
        SELECT id FROM restart_history ORDER BY created_at DESC LIMIT ?1
      )
    `);
    stmt.run(maxEntries);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    this.db.close();
  }
}
