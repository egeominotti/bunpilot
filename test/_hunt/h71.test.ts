// ---------------------------------------------------------------------------
// h71 – daemon identity: the `__daemon` marker may be followed by a config path
// ---------------------------------------------------------------------------
//
// BUG 1 (src/daemon/pid.ts, isBunpilotCommand)
//   The marker check required `__daemon` to be the LAST token of the command
//   line. daemonize() (src/daemon/daemonize.ts:30) appends the config path right
//   after the marker when the daemon is started with `--config`, so a
//   config-started daemon was NEVER identified as bunpilot:
//     * `daemon stop --config …`   -> "could not be confirmed", stop always failed
//     * `daemon status --config …` -> reported a live daemon as a stale PID file
//     * `daemon start --config …`  -> deleted the PID file of the LIVE daemon
//   INVARIANT: `__daemon` counts as the identity signal when it is the last or
//   second-to-last token and is never argv[0]; a marker buried further back in
//   an unrelated (PID-reused) command line must still be rejected.
//
// BUG 2 (src/cli/commands/daemon.ts, daemonStart)
//   `if (pid !== null) removePidFile(pidFile, pid)` also ran when the PID could
//   merely not be CONFIRMED as bunpilot, dropping the PID record of a process
//   that is alive and then spawning a second daemon — the first one is orphaned
//   and unkillable from the CLI.
//   INVARIANT: a live PID that cannot be confirmed keeps its PID file (warn and
//   return); only a dead PID is cleaned up; `--force` / `-f` is the escape hatch.
//
// Hermetic: unique temp dir, no ~/.bunpilot, no network, no fixed ports. Every
// spawned process is killed in afterAll. daemonize() is never allowed to spawn a
// real detached daemon: the config points its logFile at a directory, so the
// `openSync` inside daemonize fails with EISDIR *before* Bun.spawn — that EISDIR
// is used as the "daemonize was reached" sentinel.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { daemonCommand } from '../../src/cli/commands/daemon';
import { parseArgs } from '../../src/cli/index';
import { INTERNAL_ENV_KEYS } from '../../src/constants';
import {
  isBunpilotProcess,
  isProcessRunning,
  readPidFile,
  writePidFile,
} from '../../src/daemon/pid';
import { pidsMatching } from '../_helpers/procs';
import { TMP_BASE } from '../_helpers/tmp';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

// Short base path (like h20) keeps the spawned command lines well under any
// `ps` width limit, so the assertions below observe the FULL argv.
const ROOT = mkdtempSync(join(TMP_BASE, 'h71-'));
const spawned: Bun.Subprocess[] = [];

// A logFile that is a DIRECTORY: daemonize() opens it with `openSync(…, 'a')`
// and dies with EISDIR before it can spawn anything detached.
const LOG_DIR_TRAP = join(ROOT, 'logtrap');
mkdirSync(LOG_DIR_TRAP, { recursive: true });

afterAll(async () => {
  for (const proc of spawned) {
    try {
      proc.kill('SIGKILL');
    } catch {
      // already dead
    }
  }
  await Promise.allSettled(spawned.map((proc) => proc.exited));
  rmSync(ROOT, { recursive: true, force: true });
});

/** Same source as src/daemon/pid.ts readProcessCommand – used to verify argv. */
function readCommand(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replaceAll('\0', ' ').trim();
    }
    return execSync(`ps -p ${pid} -o command=`, { encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

/** Poll until the process is visible and its argv satisfies `accept`. */
async function waitForCommandWhere(pid: number, accept: (cmd: string) => boolean): Promise<string> {
  for (let i = 0; i < 200; i += 1) {
    const cmd = readCommand(pid);
    if (cmd !== null && accept(cmd)) return cmd;
    await Bun.sleep(25);
  }
  return readCommand(pid) ?? '<no command line>';
}

/** Poll until the process is visible and its argv contains `expectedTail`. */
function waitForCommand(pid: number, expectedTail: string): Promise<string> {
  return waitForCommandWhere(pid, (cmd) => cmd.includes(expectedTail));
}

/** No-space idle program so token splitting stays predictable. */
const IDLE = 'setTimeout(()=>{},9e4)';

function track(proc: Bun.Subprocess): Bun.Subprocess {
  spawned.push(proc);
  return proc;
}

/** `<bun> -e <idle> …extra` – the shape daemonize() produces for a binary. */
function spawnBun(extra: string[]): Bun.Subprocess {
  return track(
    Bun.spawn({
      cmd: [process.execPath, '-e', IDLE, ...extra],
      stdio: ['ignore', 'ignore', 'ignore'],
    }),
  );
}

async function reap(proc: Bun.Subprocess): Promise<void> {
  try {
    proc.kill('SIGKILL');
  } catch {
    // already dead
  }
  await proc.exited;
}

interface Captured {
  lines: string[];
  restore: () => void;
}

function captureConsole(): Captured {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const sink = (...args: unknown[]): void => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  console.log = sink;
  console.error = sink;
  return {
    lines,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

/** Config whose daemon paths live in ROOT and whose logFile is the EISDIR trap. */
function writeConfig(stem: string): { configPath: string; pidFile: string } {
  const configPath = join(ROOT, `${stem}.config.ts`);
  const pidFile = join(ROOT, `${stem}.pid`);
  writeFileSync(
    configPath,
    `export default {\n` +
      `  apps: [{ name: 'h71-${stem}', script: 'noop.ts' }],\n` +
      `  daemon: {\n` +
      `    pidFile: ${JSON.stringify(pidFile)},\n` +
      `    socketFile: ${JSON.stringify(join(ROOT, `${stem}.sock`))},\n` +
      `    logFile: ${JSON.stringify(LOG_DIR_TRAP)},\n` +
      `  },\n` +
      `};\n`,
  );
  return { configPath, pidFile };
}

/** Run `daemon start`, returning the error daemonize threw (EISDIR) or null. */
async function runStart(
  configPath: string,
  flags: Record<string, string | boolean>,
): Promise<{ error: Error | null; lines: string[] }> {
  const captured = captureConsole();
  let error: Error | null = null;
  try {
    await daemonCommand(['start'], { config: configPath, ...flags });
  } catch (err) {
    error = err as Error;
  } finally {
    captured.restore();
  }
  return { error, lines: captured.lines };
}

/** True when the thrown error proves daemonize() ran (it hit the logFile trap). */
function reachedDaemonize(error: Error | null): boolean {
  return error !== null && /EISDIR/.test(String(error.message));
}

// ---------------------------------------------------------------------------
// BUG 1 – isBunpilotProcess against real processes
// ---------------------------------------------------------------------------

test('control: `__daemon` as the last token identifies a bunpilot daemon', async () => {
  const proc = spawnBun(['__daemon']);
  const cmd = await waitForCommand(proc.pid, '__daemon');

  expect(isProcessRunning(proc.pid)).toBe(true);
  expect(cmd.endsWith('__daemon')).toBe(true);
  expect(`${cmd} -> ${isBunpilotProcess(proc.pid)}`).toBe(`${cmd} -> true`);

  await reap(proc);
}, 20_000);

test('REGRESSION: `__daemon <config path>` is still a bunpilot daemon', async () => {
  // Exactly what daemonize() spawns for `bunpilot daemon start --config …`
  // when running as a compiled binary: [execPath, '__daemon', configPath].
  const configPath = join(ROOT, `${crypto.randomUUID().slice(0, 8)}.config.ts`);
  const proc = spawnBun(['__daemon', configPath]);
  const cmd = await waitForCommand(proc.pid, configPath);

  expect(isProcessRunning(proc.pid)).toBe(true);
  // Guard the harness: the config path must really be visible in the argv,
  // otherwise this case would degenerate into the "marker is last" control.
  expect(cmd.endsWith(`__daemon ${configPath}`)).toBe(true);
  expect(`${cmd} -> ${isBunpilotProcess(proc.pid)}`).toBe(`${cmd} -> true`);

  await reap(proc);
}, 20_000);

test('REGRESSION: `run <entry> __daemon <config path>` is still a bunpilot daemon', async () => {
  // The from-source shape: [execPath, 'run', entry, '__daemon', configPath].
  const entry = join(ROOT, 'entry.ts');
  writeFileSync(entry, `${IDLE};\n`);
  const configPath = join(ROOT, `${crypto.randomUUID().slice(0, 8)}.config.ts`);
  const proc = track(
    Bun.spawn({
      cmd: [process.execPath, 'run', entry, '__daemon', configPath],
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, BUNPILOT_DAEMON: '1' },
    }),
  );
  const cmd = await waitForCommand(proc.pid, configPath);

  expect(isProcessRunning(proc.pid)).toBe(true);
  expect(cmd.endsWith(`__daemon ${configPath}`)).toBe(true);
  expect(`${cmd} -> ${isBunpilotProcess(proc.pid)}`).toBe(`${cmd} -> true`);

  await reap(proc);
}, 20_000);

test('a `__daemon` token buried further back is NOT a bunpilot daemon', async () => {
  // Two trailing tokens after the marker: an unrelated process that happens to
  // carry `__daemon` mid-command-line must never be adopted.
  const proc = spawnBun(['__daemon', 'alpha', 'beta']);
  const cmd = await waitForCommand(proc.pid, '__daemon alpha beta');

  expect(isProcessRunning(proc.pid)).toBe(true);
  expect(`${cmd} -> ${isBunpilotProcess(proc.pid)}`).toBe(`${cmd} -> false`);

  await reap(proc);
}, 20_000);

test('a process without the marker is NOT a bunpilot daemon', async () => {
  const proc = spawnBun(['bunpilot-daemon-lookalike']);
  const cmd = await waitForCommand(proc.pid, 'bunpilot-daemon-lookalike');

  expect(isProcessRunning(proc.pid)).toBe(true);
  expect(`${cmd} -> ${isBunpilotProcess(proc.pid)}`).toBe(`${cmd} -> false`);

  await reap(proc);
}, 20_000);

test('a process whose argv[0] is `__daemon` is NOT a bunpilot daemon', async () => {
  if (!existsSync('/bin/bash')) return; // `exec -a` needs a shell that supports it
  // argv = ['__daemon', '60'] – the marker sits at index 0 and is second-to-last,
  // so only the `marker >= 1` clause keeps this foreign process out.
  const proc = track(
    Bun.spawn({
      cmd: ['/bin/bash', '-c', 'exec -a __daemon sleep 60'],
      stdio: ['ignore', 'ignore', 'ignore'],
    }),
  );
  // NB: wait for the post-`exec` argv. The transient `/bin/bash -c exec -a
  // __daemon sleep 60` command line also *contains* `__daemon`, so matching on
  // `includes` would race and observe the wrong process image.
  const cmd = await waitForCommandWhere(proc.pid, (c) => c.startsWith('__daemon'));

  expect(isProcessRunning(proc.pid)).toBe(true);
  expect(cmd.startsWith('__daemon')).toBe(true);
  expect(`${cmd} -> ${isBunpilotProcess(proc.pid)}`).toBe(`${cmd} -> false`);

  await reap(proc);
}, 20_000);

// ---------------------------------------------------------------------------
// BUG 2 – daemonStart must not delete the PID record of a live process
// ---------------------------------------------------------------------------

test('daemon start keeps the PID file of a live, unconfirmable PID and never daemonizes', async () => {
  // Precondition: the test runner itself is alive but is NOT a bunpilot daemon,
  // i.e. exactly the "alive but unconfirmed" case that used to be treated as
  // "stale, delete it".
  expect(isProcessRunning(process.pid)).toBe(true);
  expect(isBunpilotProcess(process.pid)).toBe(false);

  const { configPath, pidFile } = writeConfig('live');
  writePidFile(pidFile, process.pid);

  const { error, lines } = await runStart(configPath, {});

  expect(reachedDaemonize(error)).toBe(false);
  expect(error).toBeNull();
  // The PID record of a live process must survive: dropping it orphans a daemon
  // that still owns the control socket.
  expect(existsSync(pidFile)).toBe(true);
  expect(readPidFile(pidFile)).toBe(process.pid);
  const output = lines.join('\n');
  expect(output).toMatch(/could not be confirmed/i);
  expect(output).not.toMatch(/already running/i);
}, 20_000);

test('daemon start with --force clears the unconfirmable PID and proceeds to daemonize', async () => {
  const { configPath, pidFile } = writeConfig('forced');
  writePidFile(pidFile, process.pid);

  const { error, lines } = await runStart(configPath, { force: true });

  // --force is the documented escape hatch: it must reach daemonize().
  expect(reachedDaemonize(error)).toBe(true);
  expect(existsSync(pidFile)).toBe(false);
  // …by SKIPPING the guard, not by tripping it and then continuing anyway.
  expect(lines.join('\n')).not.toMatch(/could not be confirmed/i);
}, 20_000);

test('`--force` is the only escape hatch: `-f` is the follow alias, not force', async () => {
  // The parser maps `-f` to `follow` (for `logs`), so daemonStart must NOT
  // treat it as force — a flag that silently half-works is worse than none.
  const parsed = parseArgs(['bun', 'bunpilot', 'daemon', 'start', '-f']);
  expect(parsed.flags.follow).toBe(true);
  expect(parsed.flags.force).toBeUndefined();

  // …and `--force` really does parse to the flag daemonStart reads.
  const forced = parseArgs(['bun', 'bunpilot', 'daemon', 'start', '--force']);
  expect(forced.flags.force).toBe(true);

  // Behaviourally: `-f` against a live, unconfirmable PID must still refuse.
  const { configPath, pidFile } = writeConfig('short-f-is-not-force');
  writePidFile(pidFile, process.pid);

  const { error, lines } = await runStart(configPath, parsed.flags);

  expect(reachedDaemonize(error)).toBe(false);
  expect(existsSync(pidFile)).toBe(true);
  expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(process.pid));
  expect(lines.join('\n')).toMatch(/could not be confirmed/i);
}, 20_000);

test('`--force` never displaces a CONFIRMED daemon', async () => {
  // Removing a confirmed daemon's PID file leaves it alive, healthy and
  // unmanageable, while the replacement dies on the already-bound socket.
  const { configPath, pidFile } = writeConfig('forced-vs-confirmed');
  const child = spawnBun(['__daemon']);
  await waitForCommand(child.pid, '__daemon');
  writePidFile(pidFile, child.pid);

  const { error, lines } = await runStart(configPath, { force: true });

  expect(reachedDaemonize(error)).toBe(false);
  expect(existsSync(pidFile)).toBe(true);
  expect(readFileSync(pidFile, 'utf-8').trim()).toBe(String(child.pid));
  expect(lines.join('\n')).toMatch(/already running/i);
}, 20_000);

test('daemon start cleans up a PID file that holds a dead PID', async () => {
  const { configPath, pidFile } = writeConfig('dead');
  const deadPid = 99_999_999; // above PID_MAX on every supported platform
  expect(isProcessRunning(deadPid)).toBe(false);
  writePidFile(pidFile, deadPid);

  const { error, lines } = await runStart(configPath, {});

  expect(reachedDaemonize(error)).toBe(true);
  expect(existsSync(pidFile)).toBe(false);
  // A dead PID is not an "unconfirmable live PID": it must take the cleanup
  // path, not the new warn-and-return path.
  expect(lines.join('\n')).not.toMatch(/could not be confirmed/i);
}, 20_000);

test('END-TO-END: a config-started daemon is recognized and start refuses to touch it', async () => {
  // The exact production shape both bugs conspired on: daemonize() spawned
  // `<bun> __daemon <config>`, isBunpilotCommand() then failed to recognize it,
  // and daemonStart() deleted the PID file of that LIVE daemon and spawned a
  // second one — orphaning the first with the control socket still held.
  const { configPath, pidFile } = writeConfig('e2e');
  const proc = spawnBun(['__daemon', configPath]);
  const cmd = await waitForCommand(proc.pid, configPath);
  expect(cmd.endsWith(`__daemon ${configPath}`)).toBe(true);
  expect(`${cmd} -> ${isBunpilotProcess(proc.pid)}`).toBe(`${cmd} -> true`);

  writePidFile(pidFile, proc.pid);
  const { error, lines } = await runStart(configPath, {});

  expect(error).toBeNull();
  expect(reachedDaemonize(error)).toBe(false);
  expect(existsSync(pidFile)).toBe(true);
  expect(readPidFile(pidFile)).toBe(proc.pid);
  const output = lines.join('\n');
  expect(output).toMatch(/already running/i);
  expect(output).toContain(String(proc.pid));
  expect(output).not.toMatch(/could not be confirmed/i);

  await reap(proc);
}, 20_000);

// ---------------------------------------------------------------------------
// BUG 3 – the config path travels in the ENVIRONMENT, never in argv
// ---------------------------------------------------------------------------
//
// The follow-up to BUG 1: instead of widening the marker check forever,
// daemonize() (src/daemon/daemonize.ts) stopped putting the config path in argv
// at all. `cmd` is now `[execPath, '__daemon']` / `[execPath, 'run', entry,
// '__daemon']` and the path is handed over as `BUNPILOT_CONFIG` in the child
// env; src/index.ts `case '__daemon'` reads `args[0] ?? process.env.BUNPILOT_CONFIG`
// so a hand-rolled invocation still works, and src/constants.ts lists
// BUNPILOT_CONFIG in INTERNAL_ENV_KEYS so workers never inherit it.
//
// Why it matters: `ps` joins argv with spaces, so a config path CONTAINING A
// SPACE is indistinguishable from two argv tokens. With the path in argv such a
// daemon has three trailing tokens after the marker, isBunpilotCommand() rejects
// it, and the daemon becomes unstoppable/unstatusable from the CLI.
//
// REGRESSION THAT ALREADY SHIPPED: the child inherited an ambient
// BUNPILOT_CONFIG. `bunpilot daemon start` with NO --config then had its parent
// resolve the DEFAULT pidFile while the child adopted the ambient config and
// published a DIFFERENT one — so the parent timed out, SIGKILLed a daemon that
// had already spawned workers (orphaning them) and left a pidFile behind
// pointing at a dead process. daemonize() must `delete` the inherited value.
//
// These four tests drive the REAL thing: the actual CLI entrypoint in a
// subprocess, with BUNPILOT_HOME pinned to a per-test temp dir (never
// ~/.bunpilot), the metrics listener disabled (never the fixed default port
// 9615) and every daemon/worker killed in a finally that also runs on failure.
// ---------------------------------------------------------------------------

const ENTRY = join(import.meta.dir, '../../src/index.ts');

/** Detached daemons: reaped by PID because they outlive their spawn handle. */
const detached: number[] = [];
/** Every live fixture, so afterAll can hunt leftovers by command-line token. */
const fixtures: LiveDaemon[] = [];

interface LiveDaemon {
  /** Fixture directory; also the worker cwd. */
  dir: string;
  /** Isolated BUNPILOT_HOME — the DEFAULT pid/socket/db live here. */
  home: string;
  /** Unique, alphanumeric, appears in every worker command line (pgrep). */
  token: string;
  /** Config file stem — may contain a space. */
  stem: string;
  configPath: string;
  appName: string;
  pidFile: string;
  socketFile: string;
  /** `$BUNPILOT_HOME/bunpilot.pid` – what a NO-config daemon must publish. */
  defaultPidFile: string;
  /** Written by the worker with the env it was actually handed. */
  envDump: string;
}

/**
 * A real, bootable daemon fixture: its own BUNPILOT_HOME, its own daemon paths
 * and one idle worker that dumps the env it received. `stem` may contain a
 * space — that is the entire point of moving the path out of argv.
 */
function liveFixture(name: string, stem: string): LiveDaemon {
  const dir = join(ROOT, name);
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });

  const token = `h71x${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
  const script = join(dir, `${token}.ts`);
  const envDump = join(dir, `${token}.env.json`);
  const configPath = join(dir, `${stem}.config.ts`);
  const appName = `h71-${token}`;
  const fixture: LiveDaemon = {
    dir,
    home,
    token,
    stem,
    configPath,
    appName,
    pidFile: join(dir, 'daemon.pid'),
    socketFile: join(dir, 'daemon.sock'),
    defaultPidFile: join(home, 'bunpilot.pid'),
    envDump,
  };

  // The worker records the env it was handed, then idles (and never writes to
  // stdout, so it cannot die from SIGPIPE when the daemon goes away).
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs';\n` +
      `writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({\n` +
      `  config: process.env.BUNPILOT_CONFIG ?? null,\n` +
      `  daemon: process.env.BUNPILOT_DAEMON ?? null,\n` +
      `  app: process.env.BUNPILOT_APP_NAME ?? null,\n` +
      `}));\n` +
      `setInterval(() => {}, 1000);\n`,
  );

  writeFileSync(
    configPath,
    `export default ${JSON.stringify(
      {
        daemon: {
          pidFile: fixture.pidFile,
          socketFile: fixture.socketFile,
          logFile: join(dir, 'daemon.log'),
        },
        apps: [
          {
            name: appName,
            script,
            instances: 1,
            cwd: dir,
            healthCheck: { enabled: false },
            // Metrics OFF: an enabled metrics block makes the daemon bind the
            // fixed default port 9615, which no hermetic test may claim.
            metrics: { enabled: false },
          },
        ],
      },
      null,
      2,
    )};\n`,
  );

  fixtures.push(fixture);
  return fixture;
}

/** `null` in a patch means "delete this key from the child env". */
type EnvPatch = Record<string, string | null>;

/** Child env for a real CLI/daemon run: pinned home, no leaked runner state. */
function daemonEnv(home: string, patch: EnvPatch = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env.BUNPILOT_HOME = home;
  // A socket/daemon marker leaked from the test runner would silently repoint
  // the child at another daemon's control socket.
  delete env.BUNPILOT_SOCKET;
  delete env.BUNPILOT_DAEMON;
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

interface CliRun {
  exitCode: number;
  output: string;
}

/** Run the real CLI entrypoint to completion and collect its output. */
async function runCli(args: string[], home: string, patch: EnvPatch = {}): Promise<CliRun> {
  const proc = Bun.spawn({
    cmd: [process.execPath, 'run', ENTRY, ...args],
    // An empty cwd: no config file can be discovered behind our back.
    cwd: home,
    env: daemonEnv(home, patch),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  spawned.push(proc);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, output: `${stdout}${stderr}`.trim() };
}

// PID lookup lives in ../_helpers/procs: it reads /proc directly on Linux, so
// it needs no procps and cannot silently miscount in a minimal container.

/** PIDs already signalled, so the afterAll backstop cannot hit a reused PID. */
const killedPids = new Set<number>();

function killPid(pid: number): void {
  killedPids.add(pid);
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already dead
  }
}

/**
 * Tear a fixture down: the daemon first (so it cannot respawn anything), then
 * any worker still carrying the fixture token. Safe to call twice.
 */
function shutdownFixture(fixture: LiveDaemon): void {
  for (const pidFile of [fixture.pidFile, fixture.defaultPidFile]) {
    const pid = readPidFile(pidFile);
    if (pid !== null) {
      detached.push(pid);
      killPid(pid);
    }
  }
  for (const pid of pidsMatching(fixture.token)) killPid(pid);
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
  return (await waitForFirstFile([path], timeoutMs)) !== null;
}

/** Poll until one of `paths` exists; returns the winner, or null on timeout. */
async function waitForFirstFile(paths: string[], timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const path of paths) {
      if (existsSync(path)) return path;
    }
    if (Date.now() >= deadline) return null;
    await Bun.sleep(50);
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '<no such file>';
  }
}

// Backstop: PIDs learned during the tests plus anything still carrying a
// fixture token. Runs even when a test threw before its own finally could.
afterAll(() => {
  for (const pid of detached) {
    if (!killedPids.has(pid)) killPid(pid);
  }
  for (const fixture of fixtures) {
    for (const pid of pidsMatching(fixture.token)) killPid(pid);
  }
});

test('REGRESSION: daemonize() carries the config in the env; `__daemon` stays the last token', async () => {
  const fixture = liveFixture('cfg-space', 'with space');
  try {
    // Precondition: the config path really does contain a space. Without it
    // this case degenerates into "the marker happens to be second-to-last".
    expect(fixture.configPath).toContain(' ');

    const run = await runCli(['daemon', 'start', '--config', fixture.configPath], fixture.home, {
      BUNPILOT_CONFIG: null,
    });
    expect(`${run.output} -> exit ${run.exitCode}`).toBe(`${run.output} -> exit 0`);

    // The daemon published THIS config's pidFile, so the parent's 5s readiness
    // wait was satisfied by the child it actually spawned.
    const pid = readPidFile(fixture.pidFile);
    if (pid === null) throw new Error(`no pid file at ${fixture.pidFile}; CLI said: ${run.output}`);
    detached.push(pid);
    expect(existsSync(fixture.defaultPidFile)).toBe(false);

    const cmd = await waitForCommand(pid, '__daemon');
    // The migration itself: the marker is the FINAL token and the config path
    // appears nowhere in the command line.
    expect(cmd.endsWith('__daemon')).toBe(true);
    expect(cmd).not.toContain(fixture.stem);
    expect(cmd).not.toContain('.config.ts');
    // …which is precisely what keeps a space-bearing config identifiable: with
    // the path in argv, `ps` shows three tokens after the marker and the daemon
    // can no longer be stopped or statused.
    expect(isProcessRunning(pid)).toBe(true);
    expect(`${cmd} -> ${isBunpilotProcess(pid)}`).toBe(`${cmd} -> true`);

    // The child DID receive the config — through the environment: it booted
    // this config's app.
    expect(await waitForFile(fixture.envDump, 25_000)).toBe(true);
    const workerEnv = JSON.parse(readFileSync(fixture.envDump, 'utf-8')) as {
      config: string | null;
      daemon: string | null;
      app: string | null;
    };
    expect(workerEnv.app).toBe(fixture.appName);
    // …and the worker must NOT inherit it (INTERNAL_ENV_KEYS): otherwise a
    // worker shelling out to `bunpilot` adopts its supervisor's config.
    expect(workerEnv).toEqual({ config: null, daemon: null, app: fixture.appName });
  } finally {
    shutdownFixture(fixture);
  }
}, 45_000);

test('REGRESSION: `daemon start` with no --config never adopts an ambient BUNPILOT_CONFIG', async () => {
  // The bug that shipped: daemonize() spread `process.env` into the child env
  // without clearing an inherited BUNPILOT_CONFIG. The parent resolved the
  // DEFAULT pidFile, the child adopted the ambient config and published the
  // OTHER pidFile, so the parent timed out and SIGKILLed a daemon that had
  // already spawned workers.
  const fixture = liveFixture('ambient', 'ambient');
  const previous = process.env.BUNPILOT_CONFIG;
  process.env.BUNPILOT_CONFIG = fixture.configPath;
  try {
    // No BUNPILOT_CONFIG patch: the ambient value is inherited for real.
    const run = await runCli(['daemon', 'start'], fixture.home);
    expect(`${run.output} -> exit ${run.exitCode}`).toBe(`${run.output} -> exit 0`);
    expect(run.output).not.toMatch(/did not become ready/i);

    // The daemon published the DEFAULT pidFile — the one the parent waited on.
    const pid = readPidFile(fixture.defaultPidFile);
    if (pid === null) {
      throw new Error(
        `no default pid file at ${fixture.defaultPidFile}; CLI said: ${run.output}` +
          ` (ambient pid file: ${readText(fixture.pidFile)})`,
      );
    }
    detached.push(pid);
    expect(isProcessRunning(pid)).toBe(true);
    expect(`${run.output} -> ${isBunpilotProcess(pid)}`).toBe(`${run.output} -> true`);

    // The ambient config was never loaded: no pid file, no control socket and
    // — the part that orphaned processes — no workers.
    expect(existsSync(fixture.pidFile)).toBe(false);
    expect(existsSync(fixture.socketFile)).toBe(false);
    expect(existsSync(fixture.envDump)).toBe(false);
    expect(pidsMatching(fixture.token)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.BUNPILOT_CONFIG;
    else process.env.BUNPILOT_CONFIG = previous;
    shutdownFixture(fixture);
  }
}, 45_000);

test('BUNPILOT_CONFIG is an internal env key, so workers never inherit it', () => {
  // The daemon carries its config path in BUNPILOT_CONFIG for its entire life,
  // so every worker it spawns would otherwise inherit it. The real-worker half
  // of this invariant is asserted above against a live daemon.
  expect(INTERNAL_ENV_KEYS.has('BUNPILOT_CONFIG')).toBe(true);
  expect(INTERNAL_ENV_KEYS.has('BUNPILOT_DAEMON')).toBe(true);
});

test('a hand-rolled `__daemon <config>` still wins over an ambient BUNPILOT_CONFIG', async () => {
  // `case '__daemon'` reads `args[0] ?? process.env.BUNPILOT_CONFIG`: argv is
  // the explicit request and must take precedence, or a stray environment
  // variable would silently reroute a hand-rolled daemon to another fleet.
  const argvFixture = liveFixture('argv-wins', 'argv-wins');
  const ambientFixture = liveFixture('argv-ambient', 'argv-ambient');
  const logPath = join(argvFixture.dir, 'stdio.log');
  const logDescriptor = openSync(logPath, 'a');
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, 'run', ENTRY, '__daemon', argvFixture.configPath],
      cwd: argvFixture.home,
      env: daemonEnv(argvFixture.home, {
        BUNPILOT_DAEMON: '1',
        BUNPILOT_CONFIG: ambientFixture.configPath,
      }),
      stdio: ['ignore', logDescriptor, logDescriptor],
    });
    spawned.push(proc);

    // Whichever config the daemon loaded publishes its pidFile first, so this
    // settles as soon as the loser is decided instead of burning the timeout.
    const published = await waitForFirstFile([argvFixture.pidFile, ambientFixture.pidFile], 25_000);
    const trace = readText(logPath);
    expect(`${trace} -> published ${published ?? 'nothing'}`).toBe(
      `${trace} -> published ${argvFixture.pidFile}`,
    );
    expect(readPidFile(argvFixture.pidFile)).toBe(proc.pid);

    // The env value must have lost: nothing of the ambient config exists.
    expect(existsSync(ambientFixture.pidFile)).toBe(false);
    expect(existsSync(ambientFixture.socketFile)).toBe(false);
    expect(existsSync(ambientFixture.envDump)).toBe(false);
    expect(pidsMatching(ambientFixture.token)).toEqual([]);
  } finally {
    closeSync(logDescriptor);
    shutdownFixture(argvFixture);
    shutdownFixture(ambientFixture);
  }
}, 45_000);
