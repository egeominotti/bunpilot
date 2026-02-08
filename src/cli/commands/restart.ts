// ---------------------------------------------------------------------------
// bunpm2 – CLI Command: restart
// ---------------------------------------------------------------------------
//
// Restart an application by name. All workers are stopped and re-spawned.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function restartCommand(
  args: string[],
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const name = requireArg(args, 'app-name');
  await sendCommand('restart', { name });
}
