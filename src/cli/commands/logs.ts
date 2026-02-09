// ---------------------------------------------------------------------------
// bunpilot – CLI Command: logs
// ---------------------------------------------------------------------------
//
// Display and optionally stream application logs.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';
import { logError } from '../format';

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

  let lines = DEFAULT_LINES;
  if (flags.lines) {
    const parsed = parseInt(String(flags.lines), 10);
    if (Number.isNaN(parsed)) {
      logError(`Invalid --lines value: "${String(flags.lines)}". Expected a number.`);
      process.exit(1);
    }
    if (parsed < 1) {
      logError(`Invalid --lines value: "${String(flags.lines)}". Must be at least 1.`);
      process.exit(1);
    }
    lines = parsed;
  }

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
    let lastSeenLine = logLines.length > 0 ? logLines[logLines.length - 1] : null;

    const poll = setInterval(async () => {
      try {
        const newRes = await sendCommand(
          'logs',
          { name, lines: FOLLOW_POLL_LINES },
          { silent: true },
        );
        const newLines = (newRes.data as string[]) ?? [];

        if (newLines.length === 0) {
          lastSeenLine = null;
          return;
        }

        // Find where the last seen line appears in the new batch
        let startIdx = newLines.length; // default: nothing new
        if (lastSeenLine === null) {
          // First poll after empty initial fetch — show everything
          startIdx = 0;
        } else {
          // Search backwards from the position we'd expect the last line to be
          let found = false;
          for (let i = newLines.length - 1; i >= 0; i--) {
            if (newLines[i] === lastSeenLine) {
              startIdx = i + 1;
              found = true;
              break;
            }
          }
          if (!found) {
            // Log rotation happened or last line is gone — show everything new
            startIdx = 0;
          }
        }

        if (startIdx < newLines.length) {
          for (let i = startIdx; i < newLines.length; i++) {
            process.stdout.write(newLines[i] + '\n');
          }
        }

        lastSeenLine = newLines[newLines.length - 1];
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
