// ---------------------------------------------------------------------------
// bunpm – CLI Command: reload
// ---------------------------------------------------------------------------
//
// Graceful zero-downtime reload. Workers are replaced one (or batch) at a
// time so the application stays available throughout the process.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function reloadCommand(
  args: string[],
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const name = requireArg(args, 'app-name');
  await sendCommand('reload', { name });
}
