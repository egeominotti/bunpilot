// ---------------------------------------------------------------------------
// bunpilot – Daemonization: fork master into background
// ---------------------------------------------------------------------------

import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { PID_FILE } from '../constants';
import { resolveDaemonPaths } from './paths';
import { isBunpilotProcess, isProcessRunning, readPidFile, removePidFile } from './pid';

// ---------------------------------------------------------------------------
// daemonize
// ---------------------------------------------------------------------------

/**
 * Launch the master process as a detached daemon.
 *
 * 1. Spawns `master.ts` via `Bun.spawn` with detached stdio
 * 2. Waits for the child to publish its PID as a readiness signal
 * 3. Unrefs the child so the parent can exit cleanly
 * 4. Exits the current (parent) process
 */
export async function daemonize(configPath?: string): Promise<void> {
  const paths = await resolveDaemonPaths(configPath);
  const sourceEntrypoint = process.argv[1];
  const runningFromSource = /\.[cm]?[jt]s$/.test(sourceEntrypoint ?? '');
  const cmd = runningFromSource
    ? [process.execPath, 'run', sourceEntrypoint, '__daemon']
    : [process.execPath, '__daemon'];
  if (configPath) cmd.push(configPath);
  mkdirSync(dirname(paths.logFile), { recursive: true, mode: 0o700 });
  const logDescriptor = openSync(paths.logFile, 'a', 0o600);
  chmodSync(paths.logFile, 0o600);
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({
      cmd,
      stdio: ['ignore', logDescriptor, logDescriptor],
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        BUNPILOT_DAEMON: '1',
      },
    });
  } finally {
    closeSync(logDescriptor);
  }

  const pid = child.pid;

  // The child writes its own PID only after control and metrics listeners are
  // ready. This prevents a half-booted daemon from being reported as healthy.
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) {
      removePidFile(paths.pidFile, pid);
      console.error(`bunpilot daemon failed to start; inspect ${paths.logFile}`);
      process.exit(1);
    }
    if (readPidFile(paths.pidFile) === pid) break;
    await sleep(50);
  }

  if (readPidFile(paths.pidFile) !== pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Process exited during timeout handling.
    }
    removePidFile(paths.pidFile, pid);
    console.error(`bunpilot daemon did not become ready; inspect ${paths.logFile}`);
    process.exit(1);
  }
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
export async function stopDaemon(pidFile: string = PID_FILE): Promise<boolean> {
  const pid = readPidFile(pidFile);
  if (pid === null) {
    console.log('No daemon PID file found');
    return false;
  }

  if (!isProcessRunning(pid)) {
    console.log(`Daemon (pid ${pid}) is not running – cleaning up stale PID file`);
    removePidFile(pidFile, pid);
    return true;
  }

  // Verify the process is actually bunpilot (guard against PID reuse)
  if (!isBunpilotProcess(pid)) {
    console.log(`PID ${pid} is not a bunpilot process – cleaning up stale PID file`);
    removePidFile(pidFile, pid);
    return false;
  }

  // Send graceful termination signal
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    removePidFile(pidFile, pid);
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
      removePidFile(pidFile, pid);
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

  removePidFile(pidFile, pid);
  console.log(`Daemon (pid ${pid}) force-killed after timeout`);
  return true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
