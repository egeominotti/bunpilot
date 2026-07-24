import { basename, dirname, resolve } from 'node:path';
import { loadConfigFile } from '../config/file-loader';
import { DAEMON_LOG, DB_PATH, PID_FILE, SOCKET_PATH } from '../constants';

export interface DaemonPaths {
  pidFile: string;
  socketFile: string;
  logFile: string;
}

/**
 * Resolve the desired-state store path for a daemon from its resolved PID file.
 *
 * `bootDaemon()` must NOT open the process-global `DB_PATH` unconditionally:
 * two daemons booted from different configs relocate their pid/socket/log via
 * `resolveDaemonPaths()`, and if they all shared the default store the second
 * daemon would read the first daemon's rows and adopt its apps (h40 / BUG
 * CLASS E).
 *
 * Only the canonical default PID file keeps the canonical `DB_PATH`. Any other
 * PID file — including a differently-named one that still lives in
 * `BUNPILOT_HOME` — gets a store co-located beside it and keyed on its stem, so
 * two daemons that share a directory but use distinct pid files never collide on
 * one store (h40 / BUG CLASS E).
 */
export function resolveStorePath(pidFile: string): string {
  const resolvedPid = resolve(pidFile);
  if (resolvedPid === resolve(PID_FILE)) return DB_PATH;
  const stem = basename(resolvedPid).replace(/\.[^./]*$/, '') || 'bunpilot';
  return resolve(dirname(resolvedPid), `${stem}.db`);
}

/** Resolve daemon paths from the same validated config used by the child. */
export async function resolveDaemonPaths(configPath?: string): Promise<DaemonPaths> {
  const daemon = configPath ? (await loadConfigFile(configPath)).daemon : undefined;
  const paths = {
    pidFile: resolve(daemon?.pidFile ?? PID_FILE),
    socketFile: resolve(daemon?.socketFile ?? SOCKET_PATH),
    logFile: resolve(daemon?.logFile ?? DAEMON_LOG),
  };
  if (new Set(Object.values(paths)).size !== Object.keys(paths).length) {
    throw new Error('Daemon pidFile, socketFile, and logFile paths must be distinct.');
  }
  return paths;
}
