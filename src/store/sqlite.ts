// ---------------------------------------------------------------------------
// bunpilot – SQLite Store: persistent state for apps, workers, and metrics
// ---------------------------------------------------------------------------

import { Database, type Statement } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../config/types';
import { DB_PATH } from '../constants';

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
  // Prepared statements are cached and finalized on close(). A leaked (never
  // finalized) Statement keeps Bun's soft close() deferred forever, so the
  // shutdown checkpoint never runs and all data is stranded in the -wal file
  // while the main .db is left a header-only husk (h31 / BUG CLASS N).
  private readonly statements = new Map<string, Statement>();
  private closed = false;

  constructor(dbPath: string = DB_PATH) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath, { create: true });
    if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
    this.init();
  }

  /** Prepare (or reuse) a cached Statement so it can be finalized on close(). */
  private stmt(sql: string): Statement {
    const cached = this.statements.get(sql);
    if (cached) return cached;
    const prepared = this.db.prepare(sql);
    this.statements.set(sql, prepared);
    return prepared;
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
        created_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
        updated_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        app_name    TEXT    NOT NULL,
        worker_id   INTEGER NOT NULL,
        state       TEXT    NOT NULL DEFAULT 'stopped',
        pid         INTEGER,
        started_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000),
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
        created_at  INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
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
        created_at   INTEGER NOT NULL DEFAULT (unixepoch('subsec') * 1000)
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
    this.stmt(`
      INSERT INTO apps (name, config_json, status, config_path)
      VALUES (?1, ?2, 'stopped', ?3)
      ON CONFLICT(name) DO UPDATE SET
        config_json = excluded.config_json,
        config_path = excluded.config_path,
        updated_at  = unixepoch('subsec') * 1000
    `).run(name, JSON.stringify(config), configPath ?? null);
  }

  getApp(
    name: string,
  ): { name: string; config_json: string; status: string; config_path: string | null } | null {
    return this.stmt('SELECT name, config_json, status, config_path FROM apps WHERE name = ?1').get(
      name,
    ) as {
      name: string;
      config_json: string;
      status: string;
      config_path: string | null;
    } | null;
  }

  listApps(): Array<{ name: string; config_json: string; status: string }> {
    return this.stmt('SELECT name, config_json, status FROM apps ORDER BY name').all() as Array<{
      name: string;
      config_json: string;
      status: string;
    }>;
  }

  updateAppStatus(name: string, status: string): void {
    if (!['running', 'stopped', 'errored'].includes(status)) {
      throw new Error(`Invalid app status: ${status}`);
    }
    this.stmt(
      "UPDATE apps SET status = ?1, updated_at = unixepoch('subsec') * 1000 WHERE name = ?2",
    ).run(status, name);
  }

  deleteApp(name: string): void {
    const tx = this.db.transaction(() => {
      this.stmt('DELETE FROM workers WHERE app_name = ?1').run(name);
      this.stmt('DELETE FROM restart_history WHERE app_name = ?1').run(name);
      this.stmt('DELETE FROM metrics WHERE app_name = ?1').run(name);
      this.stmt('DELETE FROM apps WHERE name = ?1').run(name);
    });
    tx();
  }

  // -------------------------------------------------------------------------
  // Worker methods
  // -------------------------------------------------------------------------

  saveWorker(appName: string, workerId: number, state: string, pid?: number): void {
    this.stmt(`
      INSERT INTO workers (app_name, worker_id, state, pid)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(app_name, worker_id) DO UPDATE SET
        state = excluded.state,
        pid   = excluded.pid,
        started_at = CASE
          WHEN excluded.pid IS NOT workers.pid THEN unixepoch('subsec') * 1000
          ELSE workers.started_at
        END
    `).run(appName, workerId, state, pid ?? null);
  }

  updateWorkerState(appName: string, workerId: number, state: string, extra?: object): void {
    this.stmt(
      'UPDATE workers SET state = ?1, extra_json = ?2 WHERE app_name = ?3 AND worker_id = ?4',
    ).run(state, extra ? JSON.stringify(extra) : null, appName, workerId);
  }

  getWorkers(appName: string): WorkerRecord[] {
    return this.stmt(
      'SELECT app_name, worker_id, state, pid, started_at, extra_json FROM workers WHERE app_name = ?1 ORDER BY worker_id',
    ).all(appName) as WorkerRecord[];
  }

  /** Drop every persisted worker row for an app (used when reconciling on boot). */
  clearWorkers(appName: string): void {
    this.stmt('DELETE FROM workers WHERE app_name = ?1').run(appName);
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
    this.stmt(`
      INSERT INTO restart_history (app_name, worker_id, pid, exit_code, signal, uptime_ms, reason)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run(appName, workerId, pid, exitCode, signal, uptimeMs, reason);
  }

  getRestartHistory(appName: string, limit: number = 50): RestartRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
      throw new Error('limit must be an integer between 1 and 10000');
    }
    return this.stmt(
      'SELECT * FROM restart_history WHERE app_name = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2',
    ).all(appName, limit) as RestartRecord[];
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
    this.stmt(`
      INSERT INTO metrics (app_name, worker_id, rss, heap_used, cpu_percent, event_loop_lag)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(appName, workerId, rss, heapUsed, cpuPercent, eventLoopLag ?? null);
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  cleanupOldMetrics(retentionMs: number): void {
    if (!Number.isFinite(retentionMs) || retentionMs < 0) {
      throw new Error('retentionMs must be a non-negative finite number');
    }
    const cutoff = Date.now() - retentionMs;
    this.stmt('DELETE FROM metrics WHERE created_at < ?1').run(cutoff);
  }

  cleanupOldRestarts(maxEntries: number): void {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) {
      throw new Error('maxEntries must be a non-negative integer');
    }
    this.stmt(`
      DELETE FROM restart_history
      WHERE id NOT IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY app_name ORDER BY created_at DESC, id DESC) AS rn
          FROM restart_history
        ) WHERE rn <= ?1
      )
    `).run(maxEntries);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  close(): void {
    if (this.closed) return;
    this.closed = true;

    // Finalize every cached statement first: while any Statement is still
    // outstanding Bun defers the real close, so the WAL is never checkpointed
    // back into the main database file.
    for (const stmt of this.statements.values()) {
      try {
        stmt.finalize();
      } catch {
        // Statement may already be finalized.
      }
    }
    this.statements.clear();

    // Flush the WAL into the main .db and truncate it, so the single .db file
    // is a complete, self-contained snapshot that can be copied/backed up.
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // Non-WAL databases (e.g. :memory:) have nothing to checkpoint.
    }

    this.db.close();
  }
}
