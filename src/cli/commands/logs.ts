// ---------------------------------------------------------------------------
// bunpilot – CLI Command: logs
// ---------------------------------------------------------------------------
//
// Display and optionally stream application logs.
// ---------------------------------------------------------------------------

import { logError } from '../format';
import { createClient, requireArg, sendCommand } from './_connect';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_LINES = 50;
const FOLLOW_POLL_INTERVAL = 1_000;
const FOLLOW_POLL_LINES = 200;
/** Upper bound on either side of the follow diff (see `findNewLogLines`). */
const MAX_DIFF_LINES = 5_000;

/**
 * Return exactly the lines that were appended since the previous snapshot.
 *
 * The daemon tail is NOT a single append-only file: `readLogLines` concatenates
 * every stream (`app-0-err`, `app-0-out`, ...) as a stable, per-stream block, so
 * a new stderr line is INSERTED in the middle of the tail rather than appended
 * at the very end. A trailing-suffix comparison would drop it forever. Instead
 * we treat `previous` and `current` as sequences and take their longest common
 * subsequence: every `current` line outside that alignment is new. This reports
 * mid-inserted lines and surfaces a freshly appended duplicate line instead of
 * hiding it.
 *
 * An LCS is required rather than a single walking pointer: each stream gets its
 * own budgeted tail, so a chatty stream's block slides off the front while a
 * quiet stream's block does not. A pointer that only advances on a match stalls
 * on the first dropped line and then classifies every following block as new,
 * re-printing it on every poll forever.
 */
export function findNewLogLines(previous: string[], current: string[]): string[] {
  if (previous.length === 0) return current;
  // The table is O(n*m); the follow window bounds both sides at
  // FOLLOW_POLL_LINES today, but this is exported, so refuse rather than
  // allocate gigabytes (and overflow Uint16Array) for a caller that is not the
  // follow loop.
  if (previous.length > MAX_DIFF_LINES || current.length > MAX_DIFF_LINES) {
    return current;
  }

  const n = previous.length;
  const m = current.length;
  const width = m + 1;
  // dp[i][j] = LCS length of previous[i..] and current[j..]. Both sides are
  // bounded by the follow window (200 lines), so the table is trivially small.
  const dp = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        previous[i] === current[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
    }
  }

  const appended: string[] = [];
  let i = 0;
  let j = 0;
  while (j < m) {
    if (i < n && previous[i] === current[j]) {
      i++; // carried over from the previous snapshot
      j++;
    } else if (i < n && dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      i++; // previous[i] fell off its stream's window
    } else {
      appended.push(current[j++]); // no counterpart in previous -> new
    }
  }

  return appended;
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

  const follow = flags.follow === true || flags.f === true;

  // Seed at the POLL width, not the display width. Each stream gets its own
  // slice of the requested budget, so a 200-line read reaches further back in
  // every stream block than a 50-line read: seeding from the narrow snapshot
  // would classify up to 150 already-excluded lines as new and dump them, out
  // of order, one second after the initial tail. The seed is taken BEFORE the
  // display read so a line appended between the two round trips is printed by
  // the display read rather than swallowed by the seed.
  const seedLines = follow
    ? (((await sendCommand('logs', { name, lines: FOLLOW_POLL_LINES }, { silent: true }))
        .data as string[]) ?? [])
    : [];

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
  if (follow) {
    // Anything the display read showed that the seed missed was appended
    // between the two requests: it has already been printed, so fold it into
    // the seen set instead of letting the first poll print it twice.
    //
    // Known limit: the fold-in appends at the END of the snapshot, while the
    // tail is a sequence of per-stream blocks. If such a line belongs to a
    // non-final block, the next poll's LCS may align it differently and either
    // print it a second time or, when the same text is legitimately logged
    // again, match the repeat against the folded-in entry and drop it. Either
    // way it is one line, in a window of one unix-socket round trip; the
    // alternatives are worse (seeding after the display read loses the line
    // outright, and a single read cannot reproduce the per-stream distribution
    // of a narrower one).
    let lastSeenSnapshot = seedLines.concat(findNewLogLines(seedLines, logLines));
    // Guard against overlapping polls: if the daemon is slow, a fixed interval
    // would stack concurrent requests (and race on lastSeenSnapshot).
    let polling = false;
    // Poll through the raw client: sendCommand turns any transient failure into
    // process.exit(1), which would kill the follower on a daemon restart and
    // makes the catch below unreachable.
    const client = createClient();

    const poll = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const newRes = await client.send('logs', { name, lines: FOLLOW_POLL_LINES });
        if (!newRes.ok) {
          // A protocol-level failure (the app was deleted) is permanent —
          // report it and stop, rather than spinning silently forever. Only
          // transport errors (handled by the catch) are worth retrying.
          clearInterval(poll);
          logError(newRes.error ?? 'logs failed');
          process.exit(1);
        }
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
