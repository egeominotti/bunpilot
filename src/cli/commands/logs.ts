// ---------------------------------------------------------------------------
// bunpm2 – CLI Command: logs
// ---------------------------------------------------------------------------
//
// Display and optionally stream application logs.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LINES = 50;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function logsCommand(
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const name = requireArg(args, 'app-name');
  const lines = flags.lines ? parseInt(String(flags.lines), 10) : DEFAULT_LINES;

  const res = await sendCommand('logs', { name, lines }, { silent: true });
  const logLines = res.data as string[];

  if (!logLines || logLines.length === 0) {
    console.log('(no logs)');
    return;
  }

  for (const line of logLines) {
    process.stdout.write(line + '\n');
  }
}
