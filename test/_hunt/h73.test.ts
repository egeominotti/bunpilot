// ---------------------------------------------------------------------------
// h73 – store + metrics endpoint hardening
// ---------------------------------------------------------------------------
//
// Three invariants, all previously violated:
//
//   1. SqliteStore's constructor must not leak an open database handle when a
//      post-open step throws. `new Database()` succeeds even on a corrupt file;
//      the very next `PRAGMA journal_mode = WAL` raises SQLITE_NOTADB (and
//      chmod can raise EPERM). Because the constructor never returns, no caller
//      ever holds the instance, so nobody can call close() — the fd is stranded
//      for the lifetime of the daemon. A daemon that retries a bad DB path
//      therefore burns one fd per attempt until it can no longer open *any*
//      file, healthy database included.
//
//   2. SqliteStore.replaceWorkers() must make the persisted worker set mirror
//      the live one EXACTLY. Boot-time orphan reconciliation kills whatever
//      PIDs these rows name, so a stale row left behind by a scale-down (or a
//      reload that renumbers workers) is a stale PID the next boot will signal.
//
//   3. The metrics HTTP server is unauthenticated. It must never answer with
//      Bun's development error page — which embeds the source of
//      http-server.ts and a stack trace. Two ways in: `req.url` is a bare path
//      when the client omits the Host header (legal in HTTP/1.0), so the old
//      unguarded `new URL(req.url)` threw; and any throw from the metrics
//      provider hit Bun's default (development) error renderer because
//      Bun.serve() got neither `development: false` nor an `error` handler.
// ---------------------------------------------------------------------------

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { type MetricsDataProvider, MetricsHttpServer } from '../../src/metrics/http-server';
import { SqliteStore } from '../../src/store/sqlite';
import { TMP_BASE } from '../_helpers/tmp';

const SQLITE_MODULE = join(import.meta.dir, '..', '..', 'src', 'store', 'sqlite.ts');

// ---------------------------------------------------------------------------
// Shared cleanup
// ---------------------------------------------------------------------------

const cleanups: Array<() => void> = [];

afterAll(() => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

// Short base path, with a portable fallback so this is not macOS-only.

/** Unique temp dir, auto-removed. Short prefix: never touches ~/.bunpilot. */
function tempDir(tag: string): string {
  const dir = mkdtempSync(join(TMP_BASE, `h73-${tag}-`));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Number of descriptors this process currently holds open. */
function openFdCount(): number {
  const fdDir = existsSync('/dev/fd') ? '/dev/fd' : '/proc/self/fd';
  return readdirSync(fdDir).length;
}

/** Grab a free high port by binding :0 and immediately releasing it. */
function freePort(): number {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') });
  const port = probe.port;
  probe.stop(true);
  // A TCP listener always reports a port; if it somehow did not, every caller
  // below would silently bind to a wrong/random port, so fail here instead.
  if (port === undefined) throw new Error('Bun.serve did not report a port');
  return port;
}

// ---------------------------------------------------------------------------
// 1 – corrupt database file must not strand the open handle
// ---------------------------------------------------------------------------

describe('h73/store: a failed SqliteStore construction releases the handle', () => {
  test('opening a corrupt database file throws', () => {
    const dir = tempDir('corrupt');
    const dbPath = join(dir, 'bunpilot.db');
    writeFileSync(dbPath, 'this is definitely not a SQLite database ----------------\n');

    // Deliberately not asserting on the SQLite error text.
    expect(() => new SqliteStore(dbPath)).toThrow();
  });

  test('failed constructions do not grow this process fd table', () => {
    const dir = tempDir('fdcount');
    const dbPath = join(dir, 'corrupt.db');
    writeFileSync(dbPath, 'this is definitely not a SQLite database ----------------\n');
    const open = (): SqliteStore => new SqliteStore(dbPath);

    // Warm-up: the first attempt pays one-off costs (module init, directory
    // creation) that are not part of the leak being measured.
    expect(open).toThrow();

    const before = openFdCount();
    let throws = 0;
    for (let i = 0; i < 50; i++) {
      try {
        open();
      } catch {
        throws++;
      }
    }
    const after = openFdCount();

    expect(throws).toBe(50);
    // INVARIANT: the open handle is released on the throw path. Measured
    // against a constructor that skips the close: exactly +50. The slack
    // absorbs unrelated fd churn from the test runner itself.
    expect(after - before).toBeLessThan(5);
  });

  test('repeated failures do not exhaust the process file descriptors', async () => {
    const dir = tempDir('fdleak');
    const dbPath = join(dir, 'corrupt.db');
    writeFileSync(dbPath, 'this is definitely not a SQLite database ----------------\n');

    // The proof runs in a child with a deliberately small fd budget: each
    // stranded handle is one fd, so a leaking constructor runs the process out
    // of descriptors long before the loop ends and the *healthy* database at
    // the end can no longer be opened. With the handle released on the throw
    // path the fd count never grows and the healthy open succeeds.
    const runner = join(dir, 'runner.ts');
    writeFileSync(
      runner,
      [
        `import { SqliteStore } from ${JSON.stringify(SQLITE_MODULE)};`,
        `const corrupt = ${JSON.stringify(dbPath)};`,
        `let throws = 0;`,
        `for (let i = 0; i < 400; i++) {`,
        `  try {`,
        `    new SqliteStore(corrupt);`,
        `    console.log('UNEXPECTED_NO_THROW');`,
        `    process.exit(3);`,
        `  } catch { throws++; }`,
        `}`,
        // The corrupt file can be replaced and a fresh store opens cleanly.
        `const good = ${JSON.stringify(join(dir, 'good.db'))};`,
        `const store = new SqliteStore(good);`,
        `store.saveWorker('h73', 0, 'online', 4242);`,
        `const workers = store.getWorkers('h73');`,
        `store.close();`,
        `console.log('H73_OK throws=' + throws + ' pid=' + workers[0].pid);`,
      ].join('\n'),
    );

    const proc = Bun.spawn(
      ['bash', '-c', `ulimit -n 128; exec ${process.execPath} run ${JSON.stringify(runner)}`],
      { cwd: dir, stdout: 'pipe', stderr: 'pipe' },
    );
    cleanups.push(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    });

    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const code = await proc.exited;
    const diag = `exit=${code}\nstdout:\n${out}\nstderr:\n${err}`;

    // INVARIANT: 400 failed opens leave the process able to open a real store.
    expect(diag).toContain('H73_OK throws=400 pid=4242');
    expect(code).toBe(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2 – replaceWorkers mirrors the live worker set exactly
// ---------------------------------------------------------------------------

describe('h73/store: replaceWorkers is an exact, atomic mirror', () => {
  function freshStore(tag: string): SqliteStore {
    const dir = tempDir(tag);
    const store = new SqliteStore(join(dir, 'bunpilot.db'));
    cleanups.push(() => store.close());
    return store;
  }

  test('scaling 3 workers down to 2 removes the third row', () => {
    const store = freshStore('scale');

    store.saveWorker('api', 0, 'online', 1001);
    store.saveWorker('api', 1, 'online', 1002);
    store.saveWorker('api', 2, 'online', 1003);
    expect(store.getWorkers('api').map((w) => w.worker_id)).toEqual([0, 1, 2]);

    store.replaceWorkers('api', [
      { id: 0, state: 'online', pid: 2001 },
      { id: 1, state: 'online', pid: 2002 },
    ]);

    const rows = store.getWorkers('api');
    // A plain upsert would leave worker 2 (pid 1003) behind — a stale PID the
    // next boot's orphan sweep would signal.
    expect(rows.map((w) => w.worker_id)).toEqual([0, 1]);
    expect(rows.map((w) => w.pid)).toEqual([2001, 2002]);
    expect(rows.map((w) => w.state)).toEqual(['online', 'online']);
  });

  test('renumbered workers do not leave ghosts, and other apps are untouched', () => {
    const store = freshStore('renumber');

    store.replaceWorkers('api', [
      { id: 0, state: 'online', pid: 3001 },
      { id: 1, state: 'online', pid: 3002 },
      { id: 2, state: 'online', pid: 3003 },
    ]);
    store.replaceWorkers('web', [{ id: 0, state: 'online', pid: 9001 }]);

    // A reload restarts with fresh ids 7/8 — ids 0..2 must not survive.
    store.replaceWorkers('api', [
      { id: 7, state: 'starting', pid: 3007 },
      { id: 8, state: 'starting', pid: null },
    ]);

    const api = store.getWorkers('api');
    expect(api.map((w) => w.worker_id)).toEqual([7, 8]);
    expect(api.map((w) => w.pid)).toEqual([3007, null]);
    expect(api.map((w) => w.state)).toEqual(['starting', 'starting']);

    // Scoped strictly to the named app.
    expect(store.getWorkers('web').map((w) => w.pid)).toEqual([9001]);
  });

  test('a throw part-way through the swap rolls the whole thing back', () => {
    const store = freshStore('rollback');

    store.replaceWorkers('api', [
      { id: 0, state: 'online', pid: 4001 },
      { id: 1, state: 'online', pid: 4002 },
    ]);

    // The second entry explodes when its state is read — after the DELETE and
    // after the first INSERT have already run. Without the surrounding
    // transaction those are committed, leaving a half-written worker set (here:
    // pid 4002 lost) for the next boot's orphan sweep to act on.
    expect(() =>
      store.replaceWorkers('api', [
        { id: 0, state: 'online', pid: 9001 },
        {
          id: 1,
          get state(): string {
            throw new Error('h73: worker state read blew up mid-swap');
          },
          pid: 9002,
        },
      ]),
    ).toThrow('h73: worker state read blew up mid-swap');

    // INVARIANT: rolled back to the pre-call set — not empty, not half-applied.
    const rows = store.getWorkers('api');
    expect(rows.map((w) => w.worker_id)).toEqual([0, 1]);
    expect(rows.map((w) => w.pid)).toEqual([4001, 4002]);
  });

  test('replacing with an empty set clears the app', () => {
    const store = freshStore('empty');

    store.replaceWorkers('api', [
      { id: 0, state: 'online', pid: 4001 },
      { id: 1, state: 'online', pid: 4002 },
    ]);
    expect(store.getWorkers('api')).toHaveLength(2);

    store.replaceWorkers('api', []);
    expect(store.getWorkers('api')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 – the unauthenticated metrics port never renders Bun's dev error page
// ---------------------------------------------------------------------------

/** Send a raw HTTP payload and collect the whole response the server writes. */
function rawRequest(port: number, payload: string, timeoutMs = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };

    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(payload);
    });
    timer = setTimeout(() => {
      sock.destroy();
      finish(() => resolve(buf));
    }, timeoutMs);

    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    sock.on('close', () => finish(() => resolve(buf)));
    sock.on('error', (error) => finish(() => reject(error)));
  });
}

/** Assert a response body carries no trace of Bun's development error page. */
function expectNoSourceLeak(body: string): void {
  expect(body).not.toContain('http-server.ts');
  expect(body).not.toContain('at ');
  // The dev overlay markers Bun actually emits (the source excerpt itself is
  // base64-packed, so these are the load-bearing assertions).
  expect(body.toLowerCase()).not.toContain('<!doctype');
  expect(body).not.toContain('__bunfallback');
  expect(body).not.toContain('BunError');
}

describe('h73/metrics: no dev error page on the unauthenticated metrics port', () => {
  let server: MetricsHttpServer | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  function makeProvider(overrides: Partial<MetricsDataProvider> = {}): MetricsDataProvider {
    return {
      getPrometheusMetrics: () => '# HELP bunpilot_up 1 if up\nbunpilot_up 1\n',
      getJsonMetrics: () => ({ apps: [] }),
      getStatus: () => ({ apps: [] }),
      ...overrides,
    };
  }

  function startServer(provider: MetricsDataProvider): number {
    const port = freePort();
    server = new MetricsHttpServer(port, provider);
    server.start();
    return port;
  }

  test('HTTP/1.0 scrape without a Host header is served, not 500-ed', async () => {
    const port = startServer(makeProvider());

    // Perfectly legal HTTP/1.0: no Host header. Bun then hands `fetch` a bare
    // path ("/metrics"), which `new URL()` cannot parse on its own.
    const raw = await rawRequest(port, 'GET /metrics HTTP/1.0\r\n\r\n');

    const [statusLine, ...rest] = raw.split('\r\n');
    const body = rest.join('\r\n').split('\r\n\r\n').slice(1).join('\r\n\r\n');

    expect(statusLine).toContain(' 200 ');
    expect(body).toContain('bunpilot_up 1');
    expectNoSourceLeak(raw);
  }, 15_000);

  test('an unknown path over HTTP/1.0 without Host is a plain 404', async () => {
    const port = startServer(makeProvider());

    const raw = await rawRequest(port, 'GET /nope HTTP/1.0\r\n\r\n');

    expect(raw.split('\r\n')[0]).toContain(' 404 ');
    expect(raw).toContain('Not Found');
    expectNoSourceLeak(raw);
  }, 15_000);

  test('a malformed Host header is a plain 400, not an escaping TypeError', async () => {
    const port = startServer(makeProvider());

    // With a Host present Bun builds an absolute `req.url`
    // ("http://h:99999999/metrics") — and a port that far out of range makes it
    // unparseable even with a base, so `new URL()` throws regardless. Unguarded
    // that TypeError escapes the handler and reaches Bun's error renderer.
    const raw = await rawRequest(
      port,
      'GET /metrics HTTP/1.1\r\nHost: h:99999999\r\nConnection: close\r\n\r\n',
    );

    expect(raw.split('\r\n')[0]).toContain(' 400 ');
    expect(raw).toContain('Bad Request: malformed request URL');
    expect(raw).not.toContain('bunpilot_up 1');
    expectNoSourceLeak(raw);
  }, 15_000);

  test('a throwing metrics provider yields a bare 500 with no source leak', async () => {
    const port = startServer(
      makeProvider({
        getPrometheusMetrics: () => {
          throw new Error('h73: provider blew up while collecting');
        },
      }),
    );

    const res = await fetch(`http://127.0.0.1:${port}/metrics`, {
      signal: AbortSignal.timeout(8_000),
    });
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(body).toBe('Internal Server Error');
    expectNoSourceLeak(body);
    // The dev page is ~65 KB of HTML; the hardened response is one line.
    expect(body.length).toBeLessThan(200);
  }, 15_000);

  test('a throwing provider on a Host-less HTTP/1.0 request also stays bare', async () => {
    const port = startServer(
      makeProvider({
        getStatus: () => {
          throw new Error('h73: status collection blew up');
        },
      }),
    );

    const raw = await rawRequest(port, 'GET /api/status HTTP/1.0\r\n\r\n');

    expect(raw.split('\r\n')[0]).toContain(' 500 ');
    expectNoSourceLeak(raw);
    expect(raw).toContain('Internal Server Error');
  }, 15_000);
});
