// ---------------------------------------------------------------------------
// bunpm2 – CLI Command: stop
// ---------------------------------------------------------------------------
//
// Stop a running application by name.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function stopCommand(
  args: string[],
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const name = requireArg(args, 'app-name');
  await sendCommand('stop', { name });
}
