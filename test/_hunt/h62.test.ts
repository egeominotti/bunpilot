// h62 — LogManager: a pipe that never settles must not stay in `activePipes`
// after `drainPipes` already timed out on it.
//
// `closeWorker` / `closeApp` / `closeAll` only `Promise.race` the pending pipe
// tasks against a 5 s timer; they never cancel the reader or the stream. A pipe
// whose write end is still held by an orphaned grandchild therefore never
// settles, `trackPipe`'s `finally` never runs, and the entry survives in
// `activePipes` — so EVERY later close pays the full 5 s drain again.

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LogsConfig } from '../../src/config/types';
import { LogManager } from '../../src/logs/manager';

const DRAIN_MS = 5_000;
const LOGS: LogsConfig = { maxSize: 10 * 1024 * 1024, maxFiles: 3 };

const tmpRoot = mkdtempSync(join('/private/tmp', 'h62-'));
const stray: number[] = [];

afterAll(() => {
  for (const pid of stray) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

test('a timed-out pipe is not re-drained by every later close', async () => {
  void tmpdir;
  const pidFile = join(tmpRoot, 'grandchild.pid');

  // Worker spawns a long-lived grandchild on INHERITED stdio, then exits.
  // The grandchild keeps the write end of both pipes open, exactly like
  // `bun run start`, `sh -c "..."` or `npm start` wrappers do.
  const script = `
    const gc = Bun.spawn(["bun", "-e", "await Bun.sleep(30000)"], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await Bun.write(${JSON.stringify(pidFile)}, String(gc.pid));
    process.exit(0);
  `;

  const proc = Bun.spawn(['bun', '-e', script], { stdout: 'pipe', stderr: 'pipe' });

  const mgr = new LogManager(join(tmpRoot, 'logs'));
  mgr.pipeOutput('gc-app', 0, proc.stdout, proc.stderr, LOGS, false);

  await proc.exited;

  // Record the grandchild so afterAll can reap it even if the test throws.
  let gcPid = 0;
  for (let i = 0; i < 50 && gcPid === 0; i++) {
    try {
      const raw = (await Bun.file(pidFile).text()).trim();
      if (raw) gcPid = Number.parseInt(raw, 10);
    } catch {
      /* not written yet */
    }
    if (gcPid === 0) await Bun.sleep(20);
  }
  expect(gcPid).toBeGreaterThan(0);
  stray.push(gcPid);

  // Sanity: the grandchild really is alive and holding the pipe write end.
  expect(() => process.kill(gcPid, 0)).not.toThrow();

  // --- 1st close: legitimately blocked, bounded by the 5 s drain timeout ----
  const t0 = Bun.nanoseconds();
  await mgr.closeWorker('gc-app', 0);
  const firstMs = (Bun.nanoseconds() - t0) / 1e6;

  // --- 2nd close: the SAME pipe must not be waited on again -----------------
  // `closeWorker` already gave up on it once; a correct implementation cancels
  // the reader/stream (or drops the entry) so this returns promptly.
  const t1 = Bun.nanoseconds();
  await mgr.closeAll();
  const secondMs = (Bun.nanoseconds() - t1) / 1e6;

  // --- 3rd close: still must be prompt --------------------------------------
  const t2 = Bun.nanoseconds();
  await mgr.closeAll();
  const thirdMs = (Bun.nanoseconds() - t2) / 1e6;

  console.log(
    `h62 drains: first=${firstMs.toFixed(0)}ms second=${secondMs.toFixed(0)}ms third=${thirdMs.toFixed(0)}ms`,
  );

  // The first close is allowed to burn the timeout budget once.
  expect(firstMs).toBeLessThan(DRAIN_MS * 1.5);

  // Every subsequent close must NOT pay the drain timeout again.
  expect(secondMs).toBeLessThan(1_000);
  expect(thirdMs).toBeLessThan(1_000);
}, 30_000);
