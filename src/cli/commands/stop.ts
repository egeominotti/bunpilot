// ---------------------------------------------------------------------------
// bunpilot – CLI Command: stop
// ---------------------------------------------------------------------------
//
// Stop a running application by name.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';
import type { AppStatus } from '../../config/types';
import { logWarn } from '../format';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function stopCommand(
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
      await sendCommand('stop', { name: app.name });
    }
    return;
  }

  await sendCommand('stop', { name });
}
