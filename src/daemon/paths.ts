import { resolve } from 'node:path';
import { loadConfigFile } from '../config/file-loader';
import { DAEMON_LOG, PID_FILE, SOCKET_PATH } from '../constants';

export interface DaemonPaths {
  pidFile: string;
  socketFile: string;
  logFile: string;
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
