// ---------------------------------------------------------------------------
// h72 – `bunpilot logs --follow` must print each log line exactly once
// ---------------------------------------------------------------------------
//
// `readLogLines` (src/logs/reader.ts) does NOT return one append-only file: it
// splits the caller's line budget round-robin across every stream and emits one
// contiguous, stable block per stream. Two consequences bit `logs -f`:
//
// BUG A — src/cli/commands/logs.ts `findNewLogLines` used a single pointer that
//   only advanced on a match. A chatty stdout block slides off the front of its
//   own window while a quiet stderr block does not, so the walk eventually hit a
//   `previous` line that had already dropped out; the pointer then stalled there
//   forever and every following line was reported as new. `logs -f` re-printed a
//   whole stream block once per second, indefinitely.
//   FIX: an LCS-based diff — unmatched `current` lines are new, and `previous`
//   lines that dropped out of their window are skipped.
//
// BUG B — `logsCommand` follow mode seeded `lastSeenSnapshot` from the INITIAL
//   fetch, taken at DEFAULT_LINES (50), while every poll asks for
//   FOLLOW_POLL_LINES (200). A 200-wide read reaches further back in EVERY
//   stream block, so the very first poll classified up to 150 already-excluded
//   older lines as new and dumped them, out of order, one second after the tail.
//   FIX: follow mode re-fetches at FOLLOW_POLL_LINES to seed the snapshot.
//
// Invariant (LOG-FOLLOW): for a log directory that does not change between
// polls, `logs --follow` writes nothing after the initial tail; and when it does
// change, it writes exactly the lines that were appended — never a whole block,
// never an already-displayed line.
// ---------------------------------------------------------------------------

import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findNewLogLines, logsCommand } from '../../src/cli/commands/logs';
import { encodeMessage, NdjsonFramer } from '../../src/control/protocol';
import { readLogLines } from '../../src/logs/reader';

// Mirrors the private constants in src/cli/commands/logs.ts.
const DEFAULT_LINES = 50;
const FOLLOW_POLL_LINES = 200;
const FOLLOW_POLL_INTERVAL = 1_000;

const APP = 'h72app';

// ---------------------------------------------------------------------------
// Temp fixtures
// ---------------------------------------------------------------------------

const roots: string[] = [];

// Short base path keeps unix socket paths under the macOS length cap; falls
// back to the platform temp dir so this is not macOS-only.
const TMP_BASE = existsSync('/private/tmp') ? '/private/tmp' : tmpdir();

function makeRoot(): string {
  // Short prefix: the stub daemon socket lives under here and unix socket paths
  // are length-capped on macOS.
  const root = mkdtempSync(join(TMP_BASE, 'h72-'));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function errLine(i: number): string {
  return `${APP}-0-err | err-${i}`;
}

function outLine(i: number): string {
  return `${APP}-0-out | out-${i}`;
}

function range(from: number, count: number, make: (i: number) => string): string[] {
  return Array.from({ length: count }, (_, k) => make(from + k));
}

/** Write one worker's stderr/stdout pair, exactly as src/logs/manager.ts names them. */
function writeStreams(root: string, errCount: number, outCount: number): void {
  const appDir = join(root, APP);
  mkdirSync(appDir, { recursive: true });
  writeFileSync(join(appDir, `${APP}-0-err.log`), `${range(0, errCount, errLine).join('\n')}\n`);
  writeFileSync(join(appDir, `${APP}-0-out.log`), `${range(0, outCount, outLine).join('\n')}\n`);
}

/** Append fresh stdout lines to the worker's stdout stream. */
function appendOut(root: string, from: number, count: number): string[] {
  const added = range(from, count, outLine);
  appendFileSync(join(root, APP, `${APP}-0-out.log`), `${added.join('\n')}\n`);
  return added;
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition never became true');
    await Bun.sleep(5);
  }
}

// ---------------------------------------------------------------------------
// BUG A — findNewLogLines
// ---------------------------------------------------------------------------

describe('h72 / bug A: findNewLogLines must diff sliding per-stream blocks', () => {
  test('a sliding stdout block next to a static stderr block yields only the new lines', () => {
    // Exactly the shape `readLogLines(dir, app, 200)` produces for a 1-worker
    // app whose stderr is quiet and whose stdout is chatty: err block pinned,
    // out block sliding by 3 lines per second.
    const err = range(0, 100, errLine);

    const previous = [...err, ...range(0, 100, outLine)]; // out-0 .. out-99
    const current = [...err, ...range(3, 100, outLine)]; // out-3 .. out-102

    // Pre-fix (single stalling pointer) this returned all 100 out lines: the
    // pointer parked on the dropped `out-0` and never matched again.
    expect(findNewLogLines(previous, current)).toEqual([outLine(100), outLine(101), outLine(102)]);

    // And the very next poll must again report only its own three lines, not a
    // block that grows on every tick.
    const next = [...err, ...range(6, 100, outLine)]; // out-6 .. out-105
    expect(findNewLogLines(current, next)).toEqual([outLine(103), outLine(104), outLine(105)]);
  });

  test('the stall is unbounded: 20 consecutive slides each report exactly 3 lines', () => {
    const err = range(0, 100, errLine);
    let previous = [...err, ...range(0, 100, outLine)];

    for (let tick = 1; tick <= 20; tick++) {
      const current = [...err, ...range(tick * 3, 100, outLine)];
      const appended = findNewLogLines(previous, current);
      expect({ tick, appended }).toEqual({
        tick,
        appended: range(97 + tick * 3, 3, outLine),
      });
      previous = current;
    }
  });

  test('a line inserted mid-tail (a fresh stderr line) is still reported', () => {
    expect(findNewLogLines(['e-1', 'o-1', 'o-2'], ['e-1', 'e-2', 'o-1', 'o-2'])).toEqual(['e-2']);
  });

  test('an appended duplicate of an existing line is reported, not swallowed', () => {
    expect(findNewLogLines(['A', 'B'], ['A', 'B', 'A'])).toEqual(['A']);
    expect(findNewLogLines(['A', 'B'], ['A', 'B', 'B'])).toEqual(['B']);
  });

  test('an unchanged snapshot yields nothing, and an empty previous yields everything', () => {
    const snapshot = [...range(0, 100, errLine), ...range(300, 100, outLine)];
    expect(findNewLogLines(snapshot, snapshot)).toEqual([]);
    expect(findNewLogLines([], snapshot)).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// BUG B — follow mode must seed at the POLL width
// ---------------------------------------------------------------------------

describe('h72 / bug B: logs --follow seeds its snapshot at the poll width', () => {
  test('the first poll writes nothing, and a later poll writes only what was appended', async () => {
    const root = makeRoot();
    // 100 stderr + 400 stdout: the 50-line read and the 200-line read reach
    // back to different points in BOTH stream blocks.
    writeStreams(root, 100, 400);

    // ---- premise: the narrow seed really is incompatible with a wide poll ----
    const narrow = readLogLines(root, APP, DEFAULT_LINES);
    const wide = readLogLines(root, APP, FOLLOW_POLL_LINES);
    expect(narrow.length).toBe(DEFAULT_LINES);
    expect(wide.length).toBe(FOLLOW_POLL_LINES);
    // Pairing the narrow tail against a wide poll misreports 150 old lines.
    expect(findNewLogLines(narrow, wide).length).toBe(FOLLOW_POLL_LINES - DEFAULT_LINES);

    // ---- stub daemon backed by the real reader ----
    const socketPath = join(root, 'd.sock');
    const requests: { cmd: string; lines: number }[] = [];

    const server = Bun.listen<{ framer: NdjsonFramer }>({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.data = { framer: new NdjsonFramer() };
        },
        data(socket, raw) {
          for (const msg of socket.data.framer.push(raw)) {
            const req = msg as { id: string; cmd: string; args?: Record<string, unknown> };
            if (req.cmd === 'logs') {
              const lines = Number(req.args?.lines);
              requests.push({ cmd: req.cmd, lines });
              const data = readLogLines(root, String(req.args?.name), lines);
              socket.write(encodeMessage({ id: req.id, ok: true, data }));
            } else {
              socket.write(encodeMessage({ id: req.id, ok: true }));
            }
          }
        },
      },
    });

    const previousSocketEnv = process.env.BUNPILOT_SOCKET;
    const realSetInterval = globalThis.setInterval;
    const realWrite = process.stdout.write.bind(process.stdout);
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const parked: (ReturnType<typeof setInterval> & { unref?: () => void })[] = [];

    let written: string[] = [];
    let pollCallback: (() => void) | null = null;
    // logsCommand is never awaited; surface any rejection instead of letting it
    // become an unhandled rejection that silently voids the assertions below.
    let commandError: unknown = null;

    try {
      process.env.BUNPILOT_SOCKET = socketPath;

      // logsCommand never resolves in follow mode (it awaits forever by
      // design) and its poll timer is private. Intercept setInterval so the
      // poll can be driven by hand — no 1s wait, no leaked timer.
      globalThis.setInterval = ((handler: unknown, delay?: number) => {
        // Only the follow poll (FOLLOW_POLL_INTERVAL) is captured, so an
        // unrelated interval armed by any other module cannot masquerade as it.
        if (delay === FOLLOW_POLL_INTERVAL) pollCallback = handler as () => void;
        // Hand back a real timer so a stray clearInterval stays valid, but keep
        // it inert and unref'd.
        const inert = realSetInterval(() => {}, 1_000_000) as ReturnType<typeof setInterval> & {
          unref?: () => void;
        };
        inert.unref?.();
        parked.push(inert);
        return inert;
      }) as unknown as typeof globalThis.setInterval;

      process.stdout.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      // Deliberately NOT awaited: follow mode never returns.
      void logsCommand([APP], { follow: true }).catch((err) => {
        commandError = err;
      });

      // The interval is installed only after the initial fetch AND the seed
      // re-fetch have both completed.
      await waitFor(() => pollCallback !== null);

      // Initial tail: the display width, nothing more.
      expect(written.length).toBe(DEFAULT_LINES);

      // ---- drive exactly one poll against an UNCHANGED directory ----
      written = [];
      const before = requests.length;
      (pollCallback as unknown as () => void)();
      await waitFor(() => requests.length > before);
      // Let the response handler finish writing whatever it decided was new.
      await Bun.sleep(50);

      // THE assertion: pre-fix this dumped 150 already-excluded older lines,
      // out of order, one second after the initial tail.
      expect(written).toEqual([]);
      expect(commandError).toBeNull();

      // ---- liveness: the same pipeline DOES print genuinely new lines ----
      // Without this, `written === []` above would also be satisfied by a poll
      // whose response was never processed at all (a dead write path proves
      // nothing). Appending 3 stdout lines slides the 200-wide stdout block by
      // 3 — the exact bug-A shape — so a correct follower prints exactly those
      // 3 lines and nothing else.
      written = [];
      const appended = appendOut(root, 400, 3);
      const beforeSecond = requests.length;
      (pollCallback as unknown as () => void)();
      await waitFor(() => requests.length > beforeSecond);
      await waitFor(() => written.length >= appended.length, 5_000);
      await Bun.sleep(50); // catch any extra (wrongly re-printed) lines
      expect(written).toEqual(appended.map((line) => `${line}\n`));
      expect(commandError).toBeNull();

      // Mechanism: request 0 = the seed at the poll width, request 1 = the
      // display tail, then one request per hand-driven poll. Pre-fix the seed
      // did not exist. The seed is taken BEFORE the display read so a line
      // appended between the two is printed by the display read and folded
      // into the seen set rather than swallowed.
      expect(requests.map((r) => r.lines)).toEqual([
        FOLLOW_POLL_LINES,
        DEFAULT_LINES,
        FOLLOW_POLL_LINES,
        FOLLOW_POLL_LINES,
      ]);
      expect(requests.every((r) => r.cmd === 'logs')).toBe(true);
    } finally {
      process.stdout.write = realWrite as typeof process.stdout.write;
      globalThis.setInterval = realSetInterval;
      for (const timer of parked) clearInterval(timer);
      for (const listener of process.listeners('SIGINT')) {
        if (!sigintBefore.has(listener)) process.removeListener('SIGINT', listener);
      }
      if (previousSocketEnv === undefined) delete process.env.BUNPILOT_SOCKET;
      else process.env.BUNPILOT_SOCKET = previousSocketEnv;
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    }
  });

  test('seeding at the poll width makes a same-width re-read a no-op', () => {
    const root = makeRoot();
    writeStreams(root, 100, 400);

    const seed = readLogLines(root, APP, FOLLOW_POLL_LINES);
    const poll = readLogLines(root, APP, FOLLOW_POLL_LINES);

    expect(findNewLogLines(seed, poll)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// BUG C — the seed/display race: a line appended BETWEEN the two round trips
// ---------------------------------------------------------------------------
//
// Follow mode issues two reads before the poll timer is armed: the wide seed
// (FOLLOW_POLL_LINES) first, then the narrow display tail (DEFAULT_LINES). The
// seed is deliberately taken FIRST so a line appended between them is PRINTED
// by the display read rather than swallowed by the seed — but that line is then
// missing from the seed, so the first poll would classify it as new and print
// it a SECOND time.
//   FIX: `lastSeenSnapshot = seedLines.concat(findNewLogLines(seedLines, logLines))`
//   — whatever the display read showed on top of the seed has already been
//   printed, so it is folded into the seen set.
//
// Bug B's test never appends between the two reads, so its fold-in always
// produces an empty array and a plain `seedLines` passes it. This one does.
// ---------------------------------------------------------------------------

describe('h72 / bug C: a line appended between seed and display read is not printed twice', () => {
  test('the display read prints it once and the first poll prints nothing', async () => {
    const root = makeRoot();
    // 100 stderr + 400 stdout, exactly bug B's shape: the wide seed lands on
    // err-0..99 + out-300..399, the narrow tail on err-75..99 + out-375..399.
    writeStreams(root, 100, 400);

    // ---- stub daemon backed by the real reader ----
    // The stub owns BOTH round trips, so it can simulate the app writing a line
    // in the window between them: it appends right after serving the seed and
    // before the display request is even sent.
    const socketPath = join(root, 'd.sock');
    const requests: { cmd: string; lines: number }[] = [];
    const raced = outLine(400); // appended between the seed and the display read
    let appendedBetweenReads = false;

    const server = Bun.listen<{ framer: NdjsonFramer }>({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.data = { framer: new NdjsonFramer() };
        },
        data(socket, raw) {
          for (const msg of socket.data.framer.push(raw)) {
            const req = msg as { id: string; cmd: string; args?: Record<string, unknown> };
            if (req.cmd === 'logs') {
              const lines = Number(req.args?.lines);
              requests.push({ cmd: req.cmd, lines });
              // Snapshot BEFORE the append: this is the seed's view of the world.
              const data = readLogLines(root, String(req.args?.name), lines);
              if (!appendedBetweenReads) {
                // The app writes one line after the seed was taken. The display
                // read (next request) will therefore include it.
                appendOut(root, 400, 1);
                appendedBetweenReads = true;
              }
              socket.write(encodeMessage({ id: req.id, ok: true, data }));
            } else {
              socket.write(encodeMessage({ id: req.id, ok: true }));
            }
          }
        },
      },
    });

    const previousSocketEnv = process.env.BUNPILOT_SOCKET;
    const realSetInterval = globalThis.setInterval;
    const realWrite = process.stdout.write.bind(process.stdout);
    const realExit = process.exit;
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const parked: (ReturnType<typeof setInterval> & { unref?: () => void })[] = [];

    let written: string[] = [];
    let pollCallback: (() => void) | null = null;
    const exitCodes: number[] = [];
    let commandError: unknown = null;

    try {
      process.env.BUNPILOT_SOCKET = socketPath;

      // No path in this test may legitimately exit; stubbing it keeps a broken
      // premise from killing the whole test runner.
      process.exit = ((code?: number) => {
        exitCodes.push(code ?? 0);
        return undefined as never;
      }) as typeof process.exit;

      globalThis.setInterval = ((handler: unknown, delay?: number) => {
        if (delay === FOLLOW_POLL_INTERVAL) pollCallback = handler as () => void;
        const inert = realSetInterval(() => {}, 1_000_000) as ReturnType<typeof setInterval> & {
          unref?: () => void;
        };
        inert.unref?.();
        parked.push(inert);
        return inert;
      }) as unknown as typeof globalThis.setInterval;

      process.stdout.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      // Deliberately NOT awaited: follow mode never returns.
      void logsCommand([APP], { follow: true }).catch((err) => {
        commandError = err;
      });

      await waitFor(() => pollCallback !== null);

      // ---- premise: the raced line really was printed by the display read ----
      expect(appendedBetweenReads).toBe(true);
      expect(written.length).toBe(DEFAULT_LINES);
      expect(written.filter((chunk) => chunk === `${raced}\n`).length).toBe(1);

      // ---- drive one poll; the directory has not changed since the tail ----
      written = [];
      const before = requests.length;
      (pollCallback as unknown as () => void)();
      await waitFor(() => requests.length > before);
      await Bun.sleep(50); // let the response handler write whatever it decided

      // THE assertion: with `lastSeenSnapshot = seedLines` (no `.concat(...)`)
      // the raced line is absent from the seen set and the first poll re-prints
      // it one second after the tail already showed it.
      expect(written).toEqual([]);

      // ---- liveness: the same pipeline still prints genuinely new lines ----
      // Without this, `written === []` would also hold for a poll whose response
      // was never processed at all.
      written = [];
      const appended = appendOut(root, 401, 1);
      const beforeSecond = requests.length;
      (pollCallback as unknown as () => void)();
      await waitFor(() => requests.length > beforeSecond);
      await waitFor(() => written.length >= appended.length, 5_000);
      await Bun.sleep(50); // catch any extra (wrongly re-printed) lines
      expect(written).toEqual(appended.map((line) => `${line}\n`));

      expect(requests.map((r) => r.lines)).toEqual([
        FOLLOW_POLL_LINES,
        DEFAULT_LINES,
        FOLLOW_POLL_LINES,
        FOLLOW_POLL_LINES,
      ]);
      expect(exitCodes).toEqual([]);
      expect(commandError).toBeNull();
    } finally {
      process.stdout.write = realWrite as typeof process.stdout.write;
      globalThis.setInterval = realSetInterval;
      process.exit = realExit;
      for (const timer of parked) clearInterval(timer);
      for (const listener of process.listeners('SIGINT')) {
        if (!sigintBefore.has(listener)) process.removeListener('SIGINT', listener);
      }
      if (previousSocketEnv === undefined) delete process.env.BUNPILOT_SOCKET;
      else process.env.BUNPILOT_SOCKET = previousSocketEnv;
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// BUG D — a poll that comes back `ok: false` must stop the follower
// ---------------------------------------------------------------------------
//
// The poll goes through the raw ControlClient (sendCommand would exit on any
// transient transport hiccup and kill a follower across a daemon restart). But
// a PROTOCOL failure — `{ok: false, error: 'App not found: ...'}`, i.e. the app
// was deleted while it was being followed — is permanent: the old code just
// `return`ed and the follower spun silently, once a second, forever.
//   FIX: clear the interval, report the error, exit 1.
// ---------------------------------------------------------------------------

describe('h72 / bug D: a non-ok poll response stops the follower instead of spinning', () => {
  test('the poll interval is cleared, the error is reported, and the process exits 1', async () => {
    const root = makeRoot();
    writeStreams(root, 10, 10); // 20 lines total: one display read shows them all

    const socketPath = join(root, 'd.sock');
    const requests: { cmd: string; lines: number }[] = [];
    const failure = `App not found: ${APP}`;

    // Requests 0 and 1 are the seed and the display tail; every poll after that
    // is answered as "the app was deleted".
    const server = Bun.listen<{ framer: NdjsonFramer }>({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.data = { framer: new NdjsonFramer() };
        },
        data(socket, raw) {
          for (const msg of socket.data.framer.push(raw)) {
            const req = msg as { id: string; cmd: string; args?: Record<string, unknown> };
            if (req.cmd === 'logs') {
              const lines = Number(req.args?.lines);
              const index = requests.length;
              requests.push({ cmd: req.cmd, lines });
              if (index < 2) {
                const data = readLogLines(root, String(req.args?.name), lines);
                socket.write(encodeMessage({ id: req.id, ok: true, data }));
              } else {
                socket.write(encodeMessage({ id: req.id, ok: false, error: failure }));
              }
            } else {
              socket.write(encodeMessage({ id: req.id, ok: true }));
            }
          }
        },
      },
    });

    const previousSocketEnv = process.env.BUNPILOT_SOCKET;
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    const realWrite = process.stdout.write.bind(process.stdout);
    const realExit = process.exit;
    const realConsoleError = console.error;
    const sigintBefore = new Set(process.listeners('SIGINT'));
    const parked: (ReturnType<typeof setInterval> & { unref?: () => void })[] = [];

    const written: string[] = [];
    const errors: string[] = [];
    // Ordered trace of the two things the fix must do, and nothing else can
    // append to it: only the poll timer's own clear is recorded.
    const events: string[] = [];
    let pollCallback: (() => void) | null = null;
    let pollTimer: unknown = null;
    let commandError: unknown = null;

    try {
      process.env.BUNPILOT_SOCKET = socketPath;

      globalThis.setInterval = ((handler: unknown, delay?: number) => {
        const inert = realSetInterval(() => {}, 1_000_000) as ReturnType<typeof setInterval> & {
          unref?: () => void;
        };
        inert.unref?.();
        parked.push(inert);
        if (delay === FOLLOW_POLL_INTERVAL) {
          pollCallback = handler as () => void;
          pollTimer = inert;
        }
        return inert;
      }) as unknown as typeof globalThis.setInterval;

      // The poll timer handle is private; the only way to observe that it was
      // stopped is to watch the clearInterval it is passed to.
      globalThis.clearInterval = ((timer: unknown) => {
        if (timer !== null && timer === pollTimer) events.push('cleared-poll');
        realClearInterval(timer as ReturnType<typeof setInterval>);
      }) as typeof globalThis.clearInterval;

      // Unstubbed, the fix would take the test runner down with it.
      process.exit = ((code?: number) => {
        events.push(`exit-${code ?? 0}`);
        return undefined as never;
      }) as typeof process.exit;

      process.stdout.write = ((chunk: unknown) => {
        written.push(String(chunk));
        return true;
      }) as typeof process.stdout.write;

      console.error = (...args: unknown[]) => {
        errors.push(args.map(String).join(' '));
      };

      void logsCommand([APP], { follow: true }).catch((err) => {
        commandError = err;
      });

      await waitFor(() => pollCallback !== null);
      expect(written.length).toBe(20); // the whole tail, both streams
      expect(events).toEqual([]);

      // ---- drive the poll that the daemon rejects ----
      written.length = 0;
      const before = requests.length;
      (pollCallback as unknown as () => void)();
      await waitFor(() => requests.length > before);
      await waitFor(() => events.length >= 2, 5_000);

      // THE assertion: pre-fix this branch was a bare `return` — no clear, no
      // exit, and the follower kept asking a dead daemon once a second forever.
      // Order matters: the timer is stopped before the process is torn down.
      expect(events).toEqual(['cleared-poll', 'exit-1']);
      // The reason reaches the user rather than being swallowed.
      expect(errors.some((line) => line.includes(failure))).toBe(true);
      // A rejected poll prints no log lines.
      expect(written).toEqual([]);

      // And nothing re-arms the poll: the follower issued exactly one request
      // after the tail and the loop is not still running behind us.
      await Bun.sleep(100);
      expect(requests.length).toBe(before + 1);
      expect(commandError).toBeNull();
    } finally {
      console.error = realConsoleError;
      process.stdout.write = realWrite as typeof process.stdout.write;
      process.exit = realExit;
      globalThis.clearInterval = realClearInterval;
      globalThis.setInterval = realSetInterval;
      for (const timer of parked) realClearInterval(timer);
      for (const listener of process.listeners('SIGINT')) {
        if (!sigintBefore.has(listener)) process.removeListener('SIGINT', listener);
      }
      if (previousSocketEnv === undefined) delete process.env.BUNPILOT_SOCKET;
      else process.env.BUNPILOT_SOCKET = previousSocketEnv;
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// BUG E — findNewLogLines refuses oversized inputs instead of allocating
// ---------------------------------------------------------------------------
//
// The LCS table is O(n*m) Uint16Array entries. The follow loop bounds both
// sides at FOLLOW_POLL_LINES (200), but the function is exported: a caller that
// hands it two 100k-line arrays would ask for a 20-billion-entry allocation
// (and overflow Uint16Array's per-cell range). Above MAX_DIFF_LINES it returns
// `current` as-is — the same answer an empty `previous` gets — without building
// anything.
// ---------------------------------------------------------------------------

describe('h72 / bug E: findNewLogLines bails out above MAX_DIFF_LINES', () => {
  // Mirrors the private constant in src/cli/commands/logs.ts.
  const MAX_DIFF_LINES = 5_000;

  test('an oversized previous side returns current itself, un-copied and un-diffed', () => {
    // One line past the cap on the `previous` side only: a table would still be
    // built for the (small) current side, so the guard has to look at both.
    const previous = range(0, MAX_DIFF_LINES + 1, outLine);
    const current = [outLine(0), outLine(1), outLine(2)];

    // Identity, not equality: the bail-out hands back the caller's array rather
    // than the result of a walk. Without the guard the diff runs and returns a
    // freshly built array (here: `[]`, since every current line is in previous).
    expect(findNewLogLines(previous, current)).toBe(current);
  });

  test('an oversized current side returns current itself', () => {
    const previous = [outLine(0), outLine(1)];
    const current = range(0, MAX_DIFF_LINES + 1, outLine);

    expect(findNewLogLines(previous, current)).toBe(current);
  });

  test('exactly MAX_DIFF_LINES is still diffed normally', () => {
    // The cap is exclusive: at the boundary the LCS must still run. Kept cheap
    // by pairing a full-width `previous` with a two-line `current` — the table
    // is (MAX_DIFF_LINES + 1) x 3, not a square.
    const previous = range(0, MAX_DIFF_LINES, outLine);
    const current = [outLine(MAX_DIFF_LINES - 1), errLine(0)];

    const appended = findNewLogLines(previous, current);
    expect(appended).not.toBe(current);
    expect(appended).toEqual([errLine(0)]);
  });
});
