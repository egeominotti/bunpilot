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
      // No `-f` alias here: the parser maps `-f` to `follow` (for `logs`).
      return daemonStart(
        typeof flags.config === 'string' ? flags.config : undefined,
        flags.force === true,
      );
    case 'stop':
      return daemonStop(typeof flags.config === 'string' ? flags.config : undefined);
    case 'status':
      return daemonStatus(typeof flags.config === 'string' ? flags.config : undefined);
  }
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

async function daemonStart(configPath?: string, force = false): Promise<void> {
  const pidFile = await resolvePidFile(configPath);
  // Check if already running
  const pid = readPidFile(pidFile);
  if (pid !== null && isProcessRunning(pid)) {
    // A CONFIRMED daemon is never displaced, not even with --force: removing
    // its PID file would leave it alive, healthy and unmanageable, while the
    // replacement dies on the already-bound control socket.
    if (isBunpilotProcess(pid)) {
      logWarn(`Daemon is already running (pid ${pid})`);
      return;
    }
    // Alive but unconfirmed. Deleting the PID file of a live process orphans it
    // if it IS the daemon: a later `daemon stop` finds no PID file and the
    // daemon becomes unkillable from the CLI. Refuse by default; --force is the
    // escape hatch for a PID an unrelated long-lived process has truly reused.
    if (!force) {
      logWarn(
        `PID ${pid} is alive but could not be confirmed as a bunpilot daemon; ` +
          'leaving the PID file intact (use --force to override)',
      );
      return;
    }
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
