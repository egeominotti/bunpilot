// ---------------------------------------------------------------------------
// bunpilot – CLI Command: daemon
// ---------------------------------------------------------------------------
//
// Manage the background daemon process.
//
// Sub-commands:
//   start   – Spawn the daemon in the background
//   stop    – Gracefully stop the running daemon
//   status  – Check whether the daemon is alive
// ---------------------------------------------------------------------------

import { PID_FILE } from '../../constants';
import { daemonize, stopDaemon } from '../../daemon/daemonize';
import { resolveDaemonPaths } from '../../daemon/paths';
import { isBunpilotProcess, isProcessRunning, readPidFile, removePidFile } from '../../daemon/pid';
import { logError, logSuccess, logWarn } from '../format';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function daemonCommand(
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const sub = args[0];

  if (!sub || !['start', 'stop', 'status'].includes(sub)) {
    logError('Usage: bunpilot daemon <start|stop|status>');
    process.exit(1);
  }

  switch (sub) {
    case 'start':
      return daemonStart(typeof flags.config === 'string' ? flags.config : undefined);
    case 'stop':
      return daemonStop(typeof flags.config === 'string' ? flags.config : undefined);
    case 'status':
      return daemonStatus(typeof flags.config === 'string' ? flags.config : undefined);
  }
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

async function daemonStart(configPath?: string): Promise<void> {
  const pidFile = await resolvePidFile(configPath);
  // Check if already running
  const pid = readPidFile(pidFile);
  if (pid !== null && isProcessRunning(pid) && isBunpilotProcess(pid)) {
    logWarn(`Daemon is already running (pid ${pid})`);
    return;
  }
  if (pid !== null) removePidFile(pidFile, pid);

  // daemonize() calls process.exit(0) internally
  await daemonize(configPath);
}

async function daemonStop(configPath?: string): Promise<void> {
  const pidFile = await resolvePidFile(configPath);
  const stopped = await stopDaemon(pidFile);
  if (stopped) {
    logSuccess('Daemon stopped');
  } else {
    logError('Failed to stop daemon');
    process.exit(1);
  }
}

async function daemonStatus(configPath?: string): Promise<void> {
  const pidFile = await resolvePidFile(configPath);
  const pid = readPidFile(pidFile);

  if (pid === null) {
    logWarn('Daemon is not running (no PID file)');
    return;
  }

  if (isProcessRunning(pid) && isBunpilotProcess(pid)) {
    logSuccess(`Daemon is running (pid ${pid})`);
  } else {
    logWarn(`Daemon is not running (stale PID file, pid ${pid})`);
  }
}

async function resolvePidFile(configPath?: string): Promise<string> {
  return configPath ? (await resolveDaemonPaths(configPath)).pidFile : PID_FILE;
}
