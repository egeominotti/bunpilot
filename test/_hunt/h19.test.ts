// ---------------------------------------------------------------------------
// H19 — a rejected `start` must not rewrite the persisted desired state
// ---------------------------------------------------------------------------
//
// AGENTS.md: "Persistence reflects successful lifecycle transitions. Failed
// starts/restarts remain retryable and must not leave stale locks or desired
// state."
//
// boot.ts builds ctx.startApp as:
//
//     store.saveApp(name, config);            // <- no configPath  => config_path = NULL
//     try { await master.startApp(config); store.updateAppStatus(name,'running'); }
//     catch { store.updateAppStatus(name, 'stopped'); throw; }
//
// The catch never captured the *previous* desired state, so a start that is
// rejected (e.g. `App "x" is already running.` — the pm2-idiomatic re-run of
// `bunpilot start app.config.ts` against a live app) downgrades a row that
// says 'running' to 'stopped', and blanks config_path. The process keeps
// running, but the next daemon boot's restore loop
// (`if (row.status !== 'running') continue`) silently skips it.
//
// This test drives the REAL bootDaemon over the REAL unix control socket in an
// isolated BUNPILOT_HOME, and inspects the REAL SqliteStore rows.
// ---------------------------------------------------------------------------

import { afterAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const TMP_BASE = '/private/tmp';

const tmpRoot = mkdtempSync(join(TMP_BASE, 'bunpilot-h19-'));
let child: ReturnType<typeof Bun.spawn> | null = null;

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

// -- seeded PRNG ------------------------------------------------------------

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

// -- the driver that runs inside the isolated daemon process ----------------

const DRIVER_SOURCE = `
const ROOT = process.env.H19_ROOT;
const HOME = process.env.BUNPILOT_HOME;
const CONFIG = process.env.H19_CONFIG;
const PLAN = JSON.parse(process.env.H19_PLAN);

const { bootDaemon } = await import(ROOT + '/src/daemon/boot.ts');
const { SqliteStore } = await import(ROOT + '/src/store/sqlite.ts');

const SOCK = HOME + '/bunpilot.sock';

function send(cmd, args) {
  const id = crypto.randomUUID();
  const payload = JSON.stringify({ id, cmd, args }) + '\\n';
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('control request timed out')), 8000);
    Bun.connect({
      unix: SOCK,
      socket: {
        open(s) { s.write(payload); },
        data(s, raw) {
          buf += new TextDecoder().decode(raw);
          let nl = buf.indexOf('\\n');
          while (nl !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (line.trim()) {
              const msg = JSON.parse(line);
              if (msg.id === id) { clearTimeout(timer); resolve(msg); s.end(); return; }
            }
            nl = buf.indexOf('\\n');
          }
        },
        error(_s, err) { clearTimeout(timer); reject(err); },
      },
    }).catch((err) => { clearTimeout(timer); reject(err); });
  });
}

function readRow(name) {
  const store = new SqliteStore(HOME + '/bunpilot.db');
  try {
    const row = store.getApp(name);
    return row ? { status: row.status, config_path: row.config_path } : null;
  } finally {
    store.close();
  }
}

const observations = [];
try {
  // Boot the daemon from the config file: every app ends up persisted with
  // status='running' and config_path=<the config file>.
  await bootDaemon(CONFIG);

  const rawConfig = await Bun.file(CONFIG).json();
  const byName = new Map(rawConfig.apps.map((a) => [a.name, a]));

  for (const step of PLAN) {
    const appConfig = byName.get(step.name);
    const before = readRow(step.name);
    const response = await send('start', { name: step.name, config: appConfig });
    const after = readRow(step.name);
    observations.push({ step, before, after, ok: response.ok, error: response.error ?? null });
  }
} catch (err) {
  console.log('H19_FATAL:' + JSON.stringify(String(err && err.stack ? err.stack : err)));
} finally {
  console.log('H19_RESULT:' + JSON.stringify(observations));
  send('kill-daemon', {}).catch(() => {});
  setTimeout(() => process.exit(0), 4000);
}
`;

// ---------------------------------------------------------------------------

interface Step {
  name: string;
  attempt: number;
}
interface Row {
  status: string;
  config_path: string | null;
}
interface Observation {
  step: Step;
  before: Row | null;
  after: Row | null;
  ok: boolean;
  error: string | null;
}

test('STORE-04: rejected start is idempotent w.r.t. persisted desired state', async () => {
  const seed = 20260723;
  const rand = mulberry32(seed);

  const metricsPort = await freePort();
  const workerPath = join(tmpRoot, 'worker.js');
  writeFileSync(workerPath, 'setInterval(() => {}, 1000);\n');

  // Seeded app set + seeded duplicate-start plan.
  const appCount = 1 + Math.floor(rand() * 3); // 1..3 apps
  const names: string[] = [];
  for (let i = 0; i < appCount; i++) {
    names.push(`app${Math.floor(rand() * 1_000_000).toString(36)}${i}`);
  }

  const apps = names.map((name) => ({
    name,
    script: workerPath,
    instances: 1,
    minUptime: 100,
    metrics: { enabled: true, httpPort: metricsPort, prometheus: false, collectInterval: 5000 },
  }));

  const configPath = join(tmpRoot, 'bunpilot.json');
  writeFileSync(configPath, JSON.stringify({ apps }, null, 2));

  const plan: Step[] = [];
  for (const name of names) {
    const attempts = 1 + Math.floor(rand() * 2); // 1..2 duplicate starts per app
    for (let a = 0; a < attempts; a++) plan.push({ name, attempt: a });
  }

  const home = join(tmpRoot, 'home');
  const driverPath = join(tmpRoot, 'driver.ts');
  writeFileSync(driverPath, DRIVER_SOURCE);

  child = Bun.spawn(['bun', 'run', driverPath], {
    cwd: tmpRoot,
    env: {
      ...process.env,
      BUNPILOT_HOME: home,
      H19_ROOT: REPO_ROOT,
      H19_CONFIG: configPath,
      H19_PLAN: JSON.stringify(plan),
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

  const fatal = stdout.split('\n').find((l) => l.startsWith('H19_FATAL:'));
  const resultLine = stdout.split('\n').find((l) => l.startsWith('H19_RESULT:'));

  if (!resultLine) {
    throw new Error(
      `driver produced no result (seed=${seed})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`,
    );
  }

  const observations: Observation[] = JSON.parse(resultLine.slice('H19_RESULT:'.length));

  if (observations.length === 0) {
    throw new Error(
      `driver collected no observations (seed=${seed})\nfatal=${fatal ?? 'none'}\n--- stderr ---\n${stderr}`,
    );
  }

  const ctx = (obs: Observation) =>
    `seed=${seed} app=${obs.step.name} attempt=${obs.step.attempt} ` +
    `before=${JSON.stringify(obs.before)} after=${JSON.stringify(obs.after)} ` +
    `ok=${obs.ok} error=${obs.error}`;

  // Preconditions. The FIRST attempt per app must have started from a live,
  // config-file-backed 'running' row, and every attempt must have been
  // REJECTED because the app is already running — otherwise the test is not
  // exercising the failure path at all.
  for (const obs of observations) {
    if (obs.step.attempt === 0) {
      expect(`${ctx(obs)} :: ${JSON.stringify(obs.before)}`).toBe(
        `${ctx(obs)} :: ${JSON.stringify({ status: 'running', config_path: configPath })}`,
      );
    }
    expect(`${ctx(obs)} :: ok=${obs.ok} error=${obs.error}`).toBe(
      `${ctx(obs)} :: ok=false error=App "${obs.step.name}" is already running.`,
    );
  }

  // INVARIANT (STORE-04): a rejected start must leave the persisted desired
  // state exactly as it found it.
  for (const obs of observations) {
    expect(`${ctx(obs)} :: after=${JSON.stringify(obs.after)}`).toBe(
      `${ctx(obs)} :: after=${JSON.stringify(obs.before)}`,
    );
  }
}, 25_000);
