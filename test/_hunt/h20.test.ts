// ---------------------------------------------------------------------------
// h20 – DMN-09: isBunpilotProcess() must recognize every process daemonize()
// spawns, regardless of where the bunpilot binary happens to be installed.
//
// daemonize() (src/daemon/daemonize.ts:27-29) builds the child argv as
//   [process.execPath, '__daemon']            (compiled single-file binary)
//   [process.execPath, 'run', entry, '__daemon']  (running from source)
// so the daemon's `ps` command line is entirely determined by the install
// path. isBunpilotCommand() (src/daemon/pid.ts:89-97) additionally requires
// the path to contain the literal substring 'bunpilot' / '/src/daemon/boot.' /
// '/src/index.'. A renamed or vendored binary therefore fails the identity
// check, and stopDaemon() treats that false negative as authorization to
// delete the PID file *without* killing the live daemon.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stopDaemon } from '../../src/daemon/daemonize';
import {
  isBunpilotProcess,
  isProcessRunning,
  readPidFile,
  writePidFile,
} from '../../src/daemon/pid';
import { pidsMatching } from '../_helpers/procs';
import { makeTempDir } from '../_helpers/tmp';

const ROOT = makeTempDir('h20-');
const spawned: Bun.Subprocess[] = [];

afterAll(() => {
  for (const proc of spawned) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
  rmSync(ROOT, { recursive: true, force: true });
});

// Deterministic PRNG so a failure is reproducible from the printed seed.
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

function randomName(rng: () => number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[Math.floor(rng() * ALPHABET.length)] ?? 'a';
  return out;
}

/** Compile a self-contained binary that idles, exactly like a shipped bunpilot. */
function buildBinary(binaryPath: string): void {
  const entry = join(ROOT, 'entry.ts');
  writeFileSync(entry, 'setTimeout(() => {}, 60_000);\n');
  const build = Bun.spawnSync({
    cmd: [process.execPath, 'build', '--compile', entry, '--outfile', binaryPath],
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!build.success) throw new Error(`bun build --compile failed: ${build.stderr.toString()}`);
}

/** Spawn `binaryPath __daemon` – byte-for-byte what daemonize() spawns. */
function spawnDaemonLike(binaryPath: string): Bun.Subprocess {
  const proc = Bun.spawn({
    cmd: [binaryPath, '__daemon'],
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, BUNPILOT_DAEMON: '1' },
  });
  spawned.push(proc);
  return proc;
}

/**
 * Wait until the process is not just alive but has actually EXEC'd.
 *
 * `Bun.spawn` returns after fork, and `isProcessRunning` is true from that
 * instant — but the command line only becomes the child's own argv after exec.
 * Reading it inside that window yields the parent's (the bun test runner's),
 * so `isBunpilotProcess` sees no `__daemon` marker and reports false. Liveness
 * alone is not enough; wait for the argv this test is actually asserting on.
 */
async function waitVisible(pid: number, argvMarker: string): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (isProcessRunning(pid) && pidsMatching(argvMarker).includes(pid)) return;
    await Bun.sleep(25);
  }
}

test('DMN-09: isBunpilotProcess recognizes daemons spawned from any install path', async () => {
  const seed = 0x5eed_1234;
  const rng = makeRng(seed);

  // Realistic install paths that do NOT contain the literal string "bunpilot":
  // renamed binary, vendored monorepo checkout, /usr/local/bin/bp, plus a few
  // seeded random names. The control case keeps "bunpilot" in the path and
  // proves the harness itself is sound.
  const cases: Array<{ label: string; binary: string; expected: boolean }> = [
    { label: 'control (path contains bunpilot)', binary: join(ROOT, 'bunpilot'), expected: true },
    { label: 'renamed binary pmtool', binary: join(ROOT, 'pmtool'), expected: true },
    { label: 'short alias bp', binary: join(ROOT, 'bp'), expected: true },
  ];
  for (let i = 0; i < 4; i += 1) {
    const name = randomName(rng, 6);
    cases.push({ label: `seeded random name ${name}`, binary: join(ROOT, name), expected: true });
  }

  for (const testCase of cases) {
    buildBinary(testCase.binary);
    const proc = spawnDaemonLike(testCase.binary);
    await waitVisible(proc.pid, testCase.binary);

    expect(isProcessRunning(proc.pid)).toBe(true);
    const identified = isBunpilotProcess(proc.pid);
    if (identified !== testCase.expected) {
      console.error(
        `DMN-09 violated (seed 0x${seed.toString(16)}): ${testCase.label} -> isBunpilotProcess(${proc.pid}) = ${identified}, argv = ${testCase.binary} __daemon`,
      );
    }
    expect(identified).toBe(testCase.expected);

    proc.kill('SIGKILL');
    await proc.exited;
  }
}, 25_000);

test('stopDaemon must never delete the PID file while the daemon is still alive', async () => {
  const binary = join(ROOT, 'pmtool-stop');
  buildBinary(binary);
  const proc = spawnDaemonLike(binary);
  // stopDaemon() calls isBunpilotProcess internally, so this case needs the
  // post-exec argv just as much as DMN-09 does.
  await waitVisible(proc.pid, binary);

  const pidFile = join(ROOT, 'state', 'daemon.pid');
  writePidFile(pidFile, proc.pid);

  const stopped = await stopDaemon(pidFile);
  const stillAlive = isProcessRunning(proc.pid);
  const pidFileAfter = readPidFile(pidFile);

  // Either the daemon was actually terminated, or its PID record survives so a
  // later stop can finish the job. Dropping the record on a live daemon leaves
  // an unkillable process holding the control socket.
  if (stillAlive) {
    expect(pidFileAfter).toBe(proc.pid);
  }
  expect(stillAlive).toBe(false);
  expect(stopped).toBe(true);

  proc.kill('SIGKILL');
}, 25_000);
