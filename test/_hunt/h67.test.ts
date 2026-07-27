// ---------------------------------------------------------------------------
// H67 — a REJECTED `start` must not mutate the persisted desired state
// ---------------------------------------------------------------------------
//
// AGENTS.md: "Persistence reflects successful lifecycle transitions. Failed
// starts/restarts remain retryable and must not leave stale locks or desired
// state."
//
// src/daemon/boot.ts:81-93
//
//     startApp: async (name) => {
//       const config = pendingConfigs.get(name);
//       if (!config) throw new Error(...);
//       store.saveApp(name, config);                       // (1) unconditional
//       try {
//         await master.startApp(config);                   // (2) may reject
//         store.updateAppStatus(name, 'running');
//       } catch (error) {
//         store.updateAppStatus(name, 'stopped');          // (3) unconditional
//         throw error;
//       }
//     }
//
// `bunpilot start ecosystem.config.ts` submits a full `start` for EVERY app in
// the file with no liveness check (src/cli/commands/start.ts:36-40), so
// re-running it against a live daemon — the natural way to re-apply an edited
// config — hits MasterOrchestrator.startApp's `App "X" is already running.`
// guard (src/core/master.ts:77-79). That rejection is a pure no-op for the
// orchestrator, but (1) has already overwritten `config_json` (SqliteStore
// .saveApp's ON CONFLICT DO UPDATE) and (3) then flips the live row's status
// to 'stopped'.
//
// Consequence: the app is still running, but its desired-state row says
// stopped, and boot's restore loop only replays rows with status 'running'
// (boot.ts:209). After the next daemon restart / host reboot the app is
// silently never brought back — and whatever path does resurrect it gets the
// second submission's script, not the one that is actually live.
//
// Property, over a seeded sequence of duplicate-start attempts: for every
// attempt that the orchestrator REJECTS, the persisted row must be byte-for-
// byte what it was before the attempt.
//
// Drives the REAL bootDaemon + REAL unix control socket + REAL SqliteStore in
// a subprocess with an isolated BUNPILOT_HOME under /private/tmp.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { makeTempDir } from '../_helpers/tmp';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const tmpRoot = makeTempDir('bunpilot-h67-');
// Spawned below with stdout/stderr piped; naming the generics keeps
// `child.stdout` / `child.stderr` typed as ReadableStream instead of the
// union `Bun.spawn`'s default overload resolves to.
let child: Subprocess<'ignore', 'pipe', 'pipe'> | null = null;

afterAll(() => {
  try {
    child?.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// -- seeded PRNG (mulberry32) ----------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

// -- driver executed inside the isolated daemon process ---------------------

const DRIVER_SOURCE = String.raw`
const ROOT   = process.env.H67_ROOT;
const HOME   = process.env.BUNPILOT_HOME;
const CONFIG = process.env.H67_CONFIG;
const PLAN   = JSON.parse(process.env.H67_PLAN);

const { bootDaemon } = await import(ROOT + '/src/daemon/boot.ts');
const { SqliteStore } = await import(ROOT + '/src/store/sqlite.ts');

const SOCK = HOME + '/bunpilot.sock';

function send(cmd, args) {
  const id = crypto.randomUUID();
  const payload = JSON.stringify({ id, cmd, args }) + '\n';
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('control request timed out')), 8000);
    Bun.connect({
      unix: SOCK,
      socket: {
        open(s) { s.write(payload); },
        data(s, raw) {
          buf += new TextDecoder().decode(raw);
          let nl = buf.indexOf('\n');
          while (nl !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim()) {
              const msg = JSON.parse(line);
              if (msg.id === id) { clearTimeout(timer); resolve(msg); s.end(); return; }
            }
            nl = buf.indexOf('\n');
          }
        },
        error(_s, err) { clearTimeout(timer); reject(err); },
      },
    }).catch((err) => { clearTimeout(timer); reject(err); });
  });
}

// Full persisted desired-state row, read back through the REAL store.
function readRow(name) {
  const store = new SqliteStore(HOME + '/bunpilot.db');
  try {
    const row = store.getApp(name);
    if (!row) return null;
    let script = null;
    try { script = JSON.parse(row.config_json).script; } catch { script = '<unparsable>'; }
    return { status: row.status, script, config_path: row.config_path };
  } finally {
    store.close();
  }
}

// Is the app actually alive according to the orchestrator?
async function liveWorkers(name) {
  const res = await send('list', {});
  const apps = (res && res.data && res.data.apps) || res?.data || [];
  const arr = Array.isArray(apps) ? apps : [];
  const app = arr.find((a) => a && a.name === name);
  if (!app) return 0;
  return (app.workers || []).filter((w) => w.state !== 'stopped' && w.state !== 'errored').length;
}

const observations = [];
try {
  await bootDaemon(CONFIG);

  const rawConfig = await Bun.file(CONFIG).json();
  const byName = new Map(rawConfig.apps.map((a) => [a.name, a]));

  for (const step of PLAN) {
    const base = byName.get(step.name);
    // The user edited the ecosystem file between runs: same app name, new script.
    const submitted = { ...base, script: step.script };
    const before = readRow(step.name);
    let response;
    try {
      response = await send('start', { name: step.name, config: submitted });
    } catch (err) {
      response = { ok: false, error: 'TRANSPORT:' + String(err) };
    }
    const after = readRow(step.name);
    const alive = await liveWorkers(step.name);
    observations.push({
      step,
      before,
      after,
      alive,
      ok: response.ok === true,
      error: response.error ?? null,
    });
  }
} catch (err) {
  console.log('H67_FATAL:' + JSON.stringify(String(err && err.stack ? err.stack : err)));
} finally {
  console.log('H67_RESULT:' + JSON.stringify(observations));
  send('kill-daemon', {}).catch(() => {});
  setTimeout(() => process.exit(0), 3000);
}
`;

// ---------------------------------------------------------------------------

interface Step {
  name: string;
  attempt: number;
  script: string;
}
interface Row {
  status: string;
  script: string | null;
  config_path: string | null;
}
interface Observation {
  step: Step;
  before: Row | null;
  after: Row | null;
  alive: number;
  ok: boolean;
  error: string | null;
}

test('STORE: a rejected duplicate start leaves the live app desired state untouched', async () => {
  const seed = 0x67_67_67;
  const rand = mulberry32(seed);

  const metricsPort = await freePort();

  const scriptV1 = join(tmpRoot, 'worker.v1.js');
  writeFileSync(scriptV1, 'setInterval(() => {}, 1000);\n');

  const appCount = 1 + Math.floor(rand() * 2); // 1..2 apps
  const names: string[] = [];
  for (let i = 0; i < appCount; i++) {
    names.push(`h67${Math.floor(rand() * 1_000_000).toString(36)}${i}`);
  }

  const apps = names.map((name) => ({
    name,
    script: scriptV1,
    instances: 1,
    minUptime: 100,
    metrics: { enabled: true, httpPort: metricsPort, prometheus: false, collectInterval: 5000 },
  }));

  const configPath = join(tmpRoot, 'bunpilot.json');
  writeFileSync(configPath, JSON.stringify({ apps }, null, 2));

  // Seeded plan of duplicate-start attempts, each carrying a fresh script path.
  const plan: Step[] = [];
  for (const name of names) {
    const attempts = 1 + Math.floor(rand() * 2); // 1..2 re-applies per app
    for (let a = 0; a < attempts; a++) {
      const scriptVN = join(tmpRoot, `worker.${name}.v${a + 2}.js`);
      writeFileSync(scriptVN, 'setInterval(() => {}, 1000);\n');
      plan.push({ name, attempt: a, script: scriptVN });
    }
  }

  const home = join(tmpRoot, 'home');
  const driverPath = join(tmpRoot, 'driver.mjs');
  writeFileSync(driverPath, DRIVER_SOURCE);

  child = Bun.spawn(['bun', 'run', driverPath], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      BUNPILOT_HOME: home,
      H67_ROOT: REPO_ROOT,
      H67_CONFIG: configPath,
      H67_PLAN: JSON.stringify(plan),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const killer = setTimeout(() => {
    try {
      child?.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }, 15_000);

  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  await child.exited;
  clearTimeout(killer);

  const lines = stdout.split('\n');
  const fatal = lines.find((l) => l.startsWith('H67_FATAL:'));
  const resultLine = lines.find((l) => l.startsWith('H67_RESULT:'));

  if (!resultLine) {
    throw new Error(
      `driver produced no result (seed=${seed})\nfatal=${fatal ?? 'none'}\n` +
        `--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }

  const observations: Observation[] = JSON.parse(resultLine.slice('H67_RESULT:'.length));

  if (observations.length === 0) {
    throw new Error(
      `driver collected no observations (seed=${seed})\nfatal=${fatal ?? 'none'}\n` +
        `--- stderr ---\n${stderr}`,
    );
  }

  const label = (o: Observation) => `seed=${seed} app=${o.step.name} attempt=${o.step.attempt}`;

  const pristine = JSON.stringify({ status: 'running', script: scriptV1, config_path: configPath });

  // ---- Preconditions: we really are on the "rejected start" path -----------
  // The very first attempt for each app starts from the row bootDaemon wrote.
  for (const o of observations.filter((x) => x.step.attempt === 0)) {
    expect(`${label(o)} before=${JSON.stringify(o.before)}`).toBe(`${label(o)} before=${pristine}`);
  }
  for (const o of observations) {
    // The orchestrator must have REJECTED the duplicate start (a pure no-op:
    // master.startApp throws before touching any state).
    expect(`${label(o)} ok=${o.ok} error=${o.error}`).toBe(
      `${label(o)} ok=false error=App "${o.step.name}" is already running.`,
    );
    // ...and the app must still be alive afterwards.
    expect(`${label(o)} aliveWorkers>0 = ${o.alive > 0}`).toBe(`${label(o)} aliveWorkers>0 = true`);
  }

  // ---- INVARIANT ----------------------------------------------------------
  // A rejected lifecycle transition must not be reflected in persistence: the
  // desired-state row must still describe the app that is actually running.
  for (const o of observations) {
    expect(`${label(o)} after=${JSON.stringify(o.after)}`).toBe(`${label(o)} after=${pristine}`);
  }
}, 25_000);
