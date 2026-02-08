// ---------------------------------------------------------------------------
// bunpilot – CLI Command: reload
// ---------------------------------------------------------------------------
//
// Graceful zero-downtime reload. Workers are replaced one (or batch) at a
// time so the application stays available throughout the process.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';
import type { AppStatus } from '../../config/types';
import { logWarn } from '../format';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function reloadCommand(
  args: string[],
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const name = requireArg(args, 'app-name');

  if (name === 'all') {
    const res = await sendCommand('list', undefined, { silent: true });
    const apps = (res.data ?? []) as AppStatus[];
    if (apps.length === 0) {
      logWarn('No applications running');
      return;
    }
    for (const app of apps) {
      await sendCommand('reload', { name: app.name });
    }
    return;
  }

  await sendCommand('reload', { name });
}
