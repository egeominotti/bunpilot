// ---------------------------------------------------------------------------
// H63 – A transient boot-time start failure must not permanently drop an app
//       from auto-restore.
// ---------------------------------------------------------------------------
//
// `apps.status` in the SQLite store is DESIRED state. If the daemon fails to
// start an app at boot for a *transient* reason (public port still held by the
// previous instance / a foreign process, mount not ready, dependency not up),
// the next daemon boot must retry it. Today boot.ts writes status='errored'
// and the restore filter only ever picks up rows with status==='running', so a
// single transient boot failure unregisters the app forever.
//
// The proof drives the REAL `bootDaemon()` in a child process (so servers and
// sockets die with the child), against a real SqliteStore under a temp
// BUNPILOT_HOME. ~/.bunpilot is never touched.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateApp } from '../../src/config/validator';
import { SqliteStore } from '../../src/store/sqlite';

const REPO = new URL('../../', import.meta.url).pathname;
const BOOT_MODULE = join(REPO, 'src/daemon/boot.ts');

// Short base path: the control socket lives under BUNPILOT_HOME and macOS
// caps unix socket paths at ~104 bytes.
const tmpHome = mkdtempSync('/private/tmp/h63-');
const spawnedPids: number[] = [];
let portHolder: ReturnType<typeof Bun.listen> | null = null;

afterAll(() => {
  try {
    portHolder?.stop(true);
  } catch {
    /* already closed */
  }
  for (const pid of spawnedPids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  rmSync(tmpHome, { recursive: true, force: true });
});

/** Bind an ephemeral port and keep holding it; returns the port number. */
function holdEphemeralPort(): { port: number; release: () => void } {
  const listener = Bun.listen({
    hostname: '0.0.0.0',
    port: 0,
    socket: {
      data() {},
      open(s) {
        s.end();
      },
    },
  });
  portHolder = listener;
  return {
    port: listener.port,
    release: () => {
      listener.stop(true);
      portHolder = null;
    },
  };
}

/** Run the real bootDaemon() to completion in a child process. */
async function runBoot(home: string): Promise<{ code: number; out: string }> {
  const runner = join(home, 'boot-runner.ts');
  writeFileSync(
    runner,
    `import { bootDaemon } from ${JSON.stringify(BOOT_MODULE)};\n` +
      `await bootDaemon();\n` +
      `process.exit(0);\n`,
  );
  const proc = Bun.spawn([process.execPath, 'run', runner], {
    env: { ...process.env, BUNPILOT_HOME: home, BUNPILOT_DAEMON: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: home,
  });
  spawnedPids.push(proc.pid);
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: `${out}\n${err}` };
}

test('a transient boot-time start failure does not permanently drop the app from auto-restore', async () => {
  // -- The app the user asked to run ----------------------------------------
  const script = join(tmpHome, 'app.js');
  writeFileSync(script, 'process.exit(0);\n');

  // A foreign process holds the app's public port at boot #1 (TIME_WAIT from
  // the previous instance, a stale sibling, ...). This is transient.
  const held = holdEphemeralPort();

  const config = validateApp({
    name: 'api',
    script,
    instances: 2,
    port: held.port,
    clustering: { enabled: true, strategy: 'proxy' },
    minUptime: 1_000,
    readyTimeout: 1_000,
  });

  // -- Seed desired state: 'api' was running before the daemon went down -----
  const seed = new SqliteStore(join(tmpHome, 'bunpilot.db'));
  seed.saveApp('api', config);
  seed.updateAppStatus('api', 'running');
  seed.close();

  // -- Boot #1: start fails because the port is still occupied --------------
  const boot1 = await runBoot(tmpHome);
  expect(boot1.code).toBe(0);
  // Sanity: the failure happened for the intended (transient) reason.
  expect(boot1.out).toContain('starting "api"');
  expect(boot1.out).toContain('failed to start "api"');

  // -- The transient cause disappears ---------------------------------------
  held.release();

  // -- Boot #2: the daemon must retry the app the user asked to run ---------
  const boot2 = await runBoot(tmpHome);
  expect(boot2.code).toBe(0);

  const after = new SqliteStore(join(tmpHome, 'bunpilot.db'));
  const row = after.getApp('api');
  for (const w of after.getWorkers('api')) if (w.pid) spawnedPids.push(w.pid);
  const restoreSet = after
    .listApps()
    .filter((r) => r.status === 'running')
    .map((r) => r.name);
  after.close();

  const diagnostic =
    `boot#2 stdout/stderr:\n${boot2.out}\n` +
    `store row after boot#2: ${JSON.stringify(row)}\n` +
    `next boot restore set: ${JSON.stringify(restoreSet)}`;

  // INVARIANT: the next boot must attempt to start the app again.
  expect(`${diagnostic}\n---\nattempted-start=${boot2.out.includes('starting "api"')}`).toContain(
    'attempted-start=true',
  );
  // ...and, the transient cause being gone, it must be running again.
  expect(row?.status).toBe('running');
}, 25_000);
