// ---------------------------------------------------------------------------
// bunpm – CLI Command: daemon
// ---------------------------------------------------------------------------
//
// Manage the background daemon process.
//
// Sub-commands:
//   start   – Spawn the daemon in the background
//   stop    – Gracefully stop the running daemon
//   status  – Check whether the daemon is alive
// ---------------------------------------------------------------------------

import { daemonize, stopDaemon } from '../../daemon/daemonize';
import { readPidFile, isProcessRunning } from '../../daemon/pid';
import { PID_FILE } from '../../constants';
import { logError, logSuccess, logWarn } from '../format';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function daemonCommand(
  args: string[],
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const sub = args[0];

  if (!sub || !['start', 'stop', 'status'].includes(sub)) {
    logError('Usage: bunpm daemon <start|stop|status>');
    process.exit(1);
  }

  switch (sub) {
    case 'start':
      return daemonStart();
    case 'stop':
      return daemonStop();
    case 'status':
      return daemonStatus();
  }
}

// ---------------------------------------------------------------------------
// Sub-commands
// ---------------------------------------------------------------------------

function daemonStart(): void {
  // Check if already running
  const pid = readPidFile(PID_FILE);
  if (pid !== null && isProcessRunning(pid)) {
    logWarn(`Daemon is already running (pid ${pid})`);
    return;
  }

  // daemonize() calls process.exit(0) internally
  daemonize(process.cwd());
}

async function daemonStop(): Promise<void> {
  const stopped = await stopDaemon();
  if (stopped) {
    logSuccess('Daemon stopped');
  } else {
    logError('Failed to stop daemon');
    process.exit(1);
  }
}

function daemonStatus(): void {
  const pid = readPidFile(PID_FILE);

  if (pid === null) {
    logWarn('Daemon is not running (no PID file)');
    return;
  }

  if (isProcessRunning(pid)) {
    logSuccess(`Daemon is running (pid ${pid})`);
  } else {
    logWarn(`Daemon is not running (stale PID file, pid ${pid})`);
  }
}
