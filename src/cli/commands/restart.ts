// ---------------------------------------------------------------------------
// bunpilot – CLI Command: restart
// ---------------------------------------------------------------------------
//
// Restart an application by name. All workers are stopped and re-spawned.
// ---------------------------------------------------------------------------

import type { AppStatus } from '../../config/types';
import { logWarn } from '../format';
import { requireArg, sendCommand } from './_connect';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function restartCommand(
  args: string[],
  flags: Record<string, string | boolean>,
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
      await sendCommand('restart', restartArgs(app.name, flags));
    }
    return;
  }

  await sendCommand('restart', restartArgs(name, flags));
}

function restartArgs(
  name: string,
  flags: Record<string, string | boolean>,
): { name: string; force?: true } {
  return flags.force === true ? { name, force: true } : { name };
}
