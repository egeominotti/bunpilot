// ---------------------------------------------------------------------------
// bunpilot – Daemonization: fork master into background
// ---------------------------------------------------------------------------

import { resolve } from 'node:path';
import { PID_FILE } from '../constants';
import { writePidFile, readPidFile, removePidFile, isProcessRunning } from './pid';

// ---------------------------------------------------------------------------
// daemonize
// ---------------------------------------------------------------------------

/**
 * Launch the master process as a detached daemon.
 *
 * 1. Spawns `master.ts` via `Bun.spawn` with detached stdio
 * 2. Writes the child PID to the PID file
 * 3. Unrefs the child so the parent can exit cleanly
 * 4. Exits the current (parent) process
 */
export function daemonize(configPath: string): void {
  const masterScript = resolve(import.meta.dir, '..', 'core', 'master.ts');

  const child = Bun.spawn({
    cmd: ['bun', 'run', masterScript, configPath],
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      BUNPILOT_DAEMON: '1',
    },
  });

  const pid = child.pid;

  writePidFile(PID_FILE, pid);
  child.unref();

  console.log(`bunpilot daemon started (pid ${pid})`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// stopDaemon
// ---------------------------------------------------------------------------

/**
 * Gracefully stop a running daemon.
 *
 * 1. Reads the PID from the PID file
 * 2. Sends SIGTERM to the process
 * 3. Polls until the process exits (with a timeout)
 * 4. Removes the PID file
 *
 * Returns `true` when the daemon was stopped successfully, `false` otherwise.
 */
export async function stopDaemon(): Promise<boolean> {
  const pid = readPidFile(PID_FILE);
  if (pid === null) {
    console.log('No daemon PID file found');
    return false;
  }

  if (!isProcessRunning(pid)) {
    console.log(`Daemon (pid ${pid}) is not running – cleaning up stale PID file`);
    removePidFile(PID_FILE);
    return true;
  }

  // Send graceful termination signal
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removePidFile(PID_FILE);
    return false;
  }

  // Poll until the process exits (max ~10 seconds)
  const maxWait = 10_000;
  const pollInterval = 200;
  let waited = 0;

  while (waited < maxWait) {
    await sleep(pollInterval);
    waited += pollInterval;

    if (!isProcessRunning(pid)) {
      removePidFile(PID_FILE);
      console.log(`Daemon (pid ${pid}) stopped`);
      return true;
    }
  }

  // Process did not exit in time – force kill
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already dead
  }

  removePidFile(PID_FILE);
  console.log(`Daemon (pid ${pid}) force-killed after timeout`);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
