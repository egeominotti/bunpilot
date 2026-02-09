// ---------------------------------------------------------------------------
// bunpilot – CLI Command: delete
// ---------------------------------------------------------------------------
//
// Delete an application from the daemon. The app is stopped (if running)
// and removed from the process list.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';
import type { AppStatus } from '../../config/types';
import { logWarn } from '../format';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function deleteCommand(
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const name = requireArg(args, 'app-name');

  if (name === 'all') {
    // ---- Confirmation gate (skip with --force) ----
    if (!flags.force) {
      process.stdout.write('Delete ALL apps? This cannot be undone. [y/N] ');

      const answer = await readLine();
      if (answer.toLowerCase() !== 'y') {
        logWarn('Aborted');
        return;
      }
    }

    const res = await sendCommand('list', undefined, { silent: true });
    const apps = (res.data ?? []) as AppStatus[];
    if (apps.length === 0) {
      logWarn('No applications to delete');
      return;
    }
    for (const app of apps) {
      await sendCommand('delete', { name: app.name });
    }
    return;
  }

  // ---- Confirmation gate (skip with --force) ----
  if (!flags.force) {
    process.stdout.write(`Delete app "${name}"? This cannot be undone. [y/N] `);

    const answer = await readLine();
    if (answer.toLowerCase() !== 'y') {
      logWarn('Aborted');
      return;
    }
  }

  await sendCommand('delete', { name });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a single line from stdin. */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.resume();

    process.stdin.on('data', (chunk: string) => {
      data += chunk;
      if (data.includes('\n')) {
        process.stdin.pause();
        resolve(data.trim());
      }
    });

    process.stdin.on('end', () => {
      process.stdin.pause();
      resolve(data.trim());
    });
  });
}
