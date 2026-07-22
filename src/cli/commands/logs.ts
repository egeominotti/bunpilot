// ---------------------------------------------------------------------------
// bunpilot – CLI Command: logs
// ---------------------------------------------------------------------------
//
// Display and optionally stream application logs.
// ---------------------------------------------------------------------------

import { logError } from '../format';
import { requireArg, sendCommand } from './_connect';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LINES = 50;
const FOLLOW_POLL_INTERVAL = 1_000;
const FOLLOW_POLL_LINES = 200;

/** Return only lines after the longest recognizable suffix of the prior tail. */
export function findNewLogLines(previous: string[], current: string[]): string[] {
  if (previous.length === 0) return current;

  const maxOverlap = Math.min(previous.length, current.length);
  for (let overlap = maxOverlap; overlap >= 1; overlap--) {
    const suffix = previous.slice(previous.length - overlap);
    for (let start = 0; start + overlap <= current.length; start++) {
      let matches = true;
      for (let offset = 0; offset < overlap; offset++) {
        if (current[start + offset] !== suffix[offset]) {
          matches = false;
          break;
        }
      }
      if (matches) return current.slice(start + overlap);
    }
  }

  return current;
}

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
    const raw = String(flags.lines);
    const parsed = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed)) {
      logError(`Invalid --lines value: "${String(flags.lines)}". Expected a number.`);
      process.exit(1);
    }
    if (parsed < 1) {
      logError(`Invalid --lines value: "${String(flags.lines)}". Must be at least 1.`);
      process.exit(1);
    }
    if (parsed > 100_000) {
      logError(`Invalid --lines value: "${String(flags.lines)}". Must not exceed 100000.`);
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
      process.stdout.write(`${line}\n`);
    }
  }

  // ---- Follow mode (--follow / -f) ----
  if (flags.follow || flags.f) {
    let lastSeenSnapshot = logLines;
    // Guard against overlapping polls: if the daemon is slow, a fixed interval
    // would stack concurrent requests (and race on lastSeenSnapshot).
    let polling = false;

    const poll = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const newRes = await sendCommand(
          'logs',
          { name, lines: FOLLOW_POLL_LINES },
          { silent: true },
        );
        const newLines = (newRes.data as string[]) ?? [];

        if (newLines.length === 0) {
          lastSeenSnapshot = [];
          return;
        }

        const appended = findNewLogLines(lastSeenSnapshot, newLines);
        for (const line of appended) {
          process.stdout.write(`${line}\n`);
        }

        lastSeenSnapshot = newLines;
      } catch {
        // Connection error during polling — silently retry next interval
      } finally {
        polling = false;
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
