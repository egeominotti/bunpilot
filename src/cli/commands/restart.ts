// ---------------------------------------------------------------------------
// bunpilot – CLI Command: restart
// ---------------------------------------------------------------------------
//
// Restart an application by name. All workers are stopped and re-spawned.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';
import type { AppStatus } from '../../config/types';
import { logWarn } from '../format';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function restartCommand(
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
      await sendCommand('restart', { name: app.name });
    }
    return;
  }

  await sendCommand('restart', { name });
}
