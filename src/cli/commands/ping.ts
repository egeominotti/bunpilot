// ---------------------------------------------------------------------------
// bunpilot – CLI Command: ping
// ---------------------------------------------------------------------------
//
// Check whether the daemon is alive and responsive. Prints the round-trip
// response time in milliseconds.
// ---------------------------------------------------------------------------

import { sendCommand } from './_connect';
import { logSuccess, logError } from '../format';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function pingCommand(
  _args: string[],
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const start = performance.now();

  try {
    await sendCommand('ping', undefined, { silent: true });
  } catch {
    logError('Daemon is not responding');
    process.exit(1);
  }

  const elapsed = (performance.now() - start).toFixed(1);
  logSuccess(`pong \u2013 ${elapsed} ms`);
}
