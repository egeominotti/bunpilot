// ---------------------------------------------------------------------------
// bunpilot – CLI Command: logs
// ---------------------------------------------------------------------------
//
// Display and optionally stream application logs.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LINES = 50;
const FOLLOW_POLL_INTERVAL = 1_000;
const FOLLOW_POLL_LINES = 200;

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
  const logLines = (res.data as string[]) ?? [];

  if (logLines.length === 0) {
    console.log('(no logs)');
  } else {
    for (const line of logLines) {
      process.stdout.write(line + '\n');
    }
  }

  // ---- Follow mode (--follow / -f) ----
  if (flags.follow || flags.f) {
    let lastLineCount = logLines.length;

    const poll = setInterval(async () => {
      try {
        const newRes = await sendCommand(
          'logs',
          { name, lines: FOLLOW_POLL_LINES },
          { silent: true },
        );
        const newLines = (newRes.data as string[]) ?? [];

        if (newLines.length > lastLineCount) {
          const delta = newLines.slice(lastLineCount);
          for (const line of delta) {
            process.stdout.write(line + '\n');
          }
          lastLineCount = newLines.length;
        }
      } catch {
        // Connection error during polling — silently retry next interval
      }
    }, FOLLOW_POLL_INTERVAL);

    process.on('SIGINT', () => {
      clearInterval(poll);
      process.exit(0);
    });

    // Keep the process alive until interrupted
    await new Promise(() => {});
  }
}
