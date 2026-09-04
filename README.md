# Bunpilot

[![CI](https://github.com/egeominotti/bunpilot/actions/workflows/ci.yml/badge.svg)](https://github.com/egeominotti/bunpilot/actions/workflows/ci.yml)
[![Release](https://github.com/egeominotti/bunpilot/actions/workflows/release.yml/badge.svg)](https://github.com/egeominotti/bunpilot/actions/workflows/release.yml)
[![npm](https://img.shields.io/npm/v/bunpilot)](https://www.npmjs.com/package/bunpilot)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

Bunpilot is a Bun-native process manager for long-running services: clustered workers, guarded crash recovery, zero-downtime rolling reloads, health checks, metrics, bounded log rotation, SQLite desired state, and graceful shutdown in one CLI.

Version 1.0 supports Linux and macOS on x64 and arm64. The daemon control plane uses Unix-domain sockets; Windows is not currently supported.

## What it provides

- Worker lifecycle with readiness deadlines and stale-generation protection
- Exponential backoff with restart windows, app isolation, and retryable rollback
- Linux `SO_REUSEPORT` clustering or a portable TCP round-robin proxy
- Rolling reloads that retain old capacity until replacements are online
- Namespaced HTTP health checks and IPC heartbeats
- CPU and memory metrics with JSON and Prometheus endpoints
- Per-worker stdout/stderr capture with bounded rotation and safe nested paths
- SQLite persistence and restoration of desired running state
- Correlated, bounded NDJSON control protocol over an owner-only Unix socket
- A side-effect-free TypeScript API and worker SDK with no runtime dependencies

## Requirements and support

| Component         | Supported                    |
| ----------------- | ---------------------------- |
| Runtime           | Bun 1.4.1                    |
| Operating systems | Linux, macOS                 |
| Architectures     | x64, arm64                   |
| Linux libc        | glibc, musl release binaries |
| Configuration     | TypeScript, JavaScript, JSON |

The standalone Bunpilot executable embeds Bun for the control plane. Managed TypeScript/JavaScript applications still use `bun run` by default, so install Bun on worker hosts unless each app supplies a custom `interpreter`.

## Install

Install the package channel:

```bash
bun add --global bunpilot
```

Or download the archive for your platform from [GitHub Releases](https://github.com/egeominotti/bunpilot/releases), verify it against `SHA256SUMS`, and put `bunpilot` on `PATH`.

Build from source:

```bash
git clone https://github.com/egeominotti/bunpilot.git
cd bunpilot
npm ci --ignore-scripts
bun run ci
bun run build
./bunpilot --version
```

## Quick start

Your worker must bind `BUNPILOT_PORT`, announce readiness, and register graceful cleanup:

```ts
import { bunpilotOnShutdown, bunpilotReady, bunpilotStartMetrics } from 'bunpilot/worker';

const server = Bun.serve({
  port: Number(process.env.BUNPILOT_PORT ?? 3000),
  reusePort: process.env.BUNPILOT_REUSE_PORT === '1',
  fetch(request) {
    if (new URL(request.url).pathname === '/health') {
      return new Response('ok');
    }
    return Response.json({ pid: process.pid });
  },
});

bunpilotReady(); // also starts IPC heartbeats
bunpilotStartMetrics();
bunpilotOnShutdown(() => server.stop(true));
```

Generate and edit a config:

```bash
bunpilot init
```

```ts
import type { BunpilotConfig } from 'bunpilot';

const config: BunpilotConfig = {
  apps: [
    {
      name: 'api',
      script: './src/server.ts',
      instances: 'max',
      port: 3000,
      env: { NODE_ENV: 'production' },
      healthCheck: {
        enabled: true,
        path: '/health',
        interval: 10_000,
        timeout: 2_000,
        unhealthyThreshold: 3,
      },
      clustering: {
        enabled: true,
        strategy: 'auto',
        rollingRestart: { batchSize: 1, batchDelay: 1_000 },
      },
      logs: {
        outFile: 'archive/api-out.log',
        errFile: 'archive/api-err.log',
        maxSize: 10 * 1024 * 1024,
        maxFiles: 5,
      },
      metrics: {
        enabled: true,
        prometheus: true,
        httpPort: 9615,
        collectInterval: 5_000,
      },
    },
  ],
};

export default config;
```

Start the daemon and application:

```bash
bunpilot daemon start --config bunpilot.config.ts
bunpilot ping --config bunpilot.config.ts
bunpilot start --config bunpilot.config.ts
bunpilot list --config bunpilot.config.ts
```

`--config` lets commands discover a custom daemon socket. You can instead pass `--socket /path/to/bunpilot.sock` or set `BUNPILOT_SOCKET`. When using custom `daemon.pidFile`, pass the same config to `daemon stop` and `daemon status`.

## Operations

```bash
bunpilot list
bunpilot status api
bunpilot logs api --lines 200
bunpilot logs api --follow
bunpilot metrics
bunpilot metrics --json
bunpilot metrics --prometheus

bunpilot reload api       # rolling replacement
bunpilot restart api      # hard restart
bunpilot restart api --force
bunpilot stop api
bunpilot delete api

bunpilot daemon status
bunpilot daemon stop
```

Lifecycle commands accept `all` where applicable. `reload` rejects stopped apps; use `restart` to bring a stopped app back.

## Configuration defaults

| Option             |                 Default | Notes                                              |
| ------------------ | ----------------------: | -------------------------------------------------- |
| `instances`        |                     `1` | `'max'` uses logical CPU count                     |
| `maxRestarts`      |                    `15` | Per restart window                                 |
| `maxRestartWindow` |                `900000` | 15 minutes                                         |
| `minUptime`        |                 `30000` | Resets consecutive crash backoff                   |
| `killTimeout`      |                  `5000` | Then escalates to `SIGKILL`                        |
| `shutdownSignal`   |               `SIGTERM` | `SIGTERM` or `SIGINT`                              |
| `readyTimeout`     |                 `30000` | Worker must call `bunpilotReady()`                 |
| `healthCheck`      |                 enabled | `/health`, 30 s interval, 5 s timeout, threshold 3 |
| `backoff`          | `1000 × 2`, max `30000` | Milliseconds                                       |
| `logs`             |     10 MiB, 5 rotations | Stored under `~/.bunpilot/logs/<app>`              |
| `metrics`          |                 enabled | 5 s collection, HTTP port 9615                     |
| `clustering`       |         enabled, `auto` | Effective only with multiple ported workers        |

Configuration is validated before use. App names and log paths cannot traverse directories; ports, intervals, restart limits, signals, environment entries, and nested objects are checked strictly. Custom log filenames are relative to the app log directory.

### Clustering

`auto` uses kernel `SO_REUSEPORT` on Linux and the Bunpilot TCP proxy elsewhere. Force `proxy` when you need identical behavior across Linux and macOS. A rolling reload adds an online replacement to the proxy before draining its predecessor.

### Metrics API

The metrics server binds only to `127.0.0.1`:

- `GET /metrics` — Prometheus exposition
- `GET /api/metrics` — JSON worker metrics
- `GET /api/metrics/:app` — one application
- `GET /api/status` — daemon status snapshot

All enabled apps in one daemon must use the same `metrics.httpPort`.

### Daemon paths

Defaults live under `BUNPILOT_HOME` (normally `~/.bunpilot`):

- `bunpilot.pid`
- `bunpilot.sock` (mode `0600`)
- `bunpilot.db`
- `bunpilot-daemon.log`
- `logs/<app>/...`

Override the base with `BUNPILOT_HOME`, the socket with `BUNPILOT_SOCKET`, or configure `daemon.pidFile`, `daemon.socketFile`, and `daemon.logFile`.

## Development and verification

```bash
bun run check          # Oxfmt formatting and Oxlint lint/import checks
bun run typecheck
bun test
bun run test:model     # deterministic fast-check model/reference invariants
bun run test:coverage
bun run simulate
bun run simulate:cluster
bun run version:check
```

The model suite uses fast-check to drive long, replayable operation sequences and independent reference models across lifecycle legality, crash-backoff isolation, telemetry ingestion, and arbitrary UTF-8 NDJSON chunking. See [AGENTS.md](./AGENTS.md) for architecture invariants and the required contributor workflow.

## Releases

Tags named `vX.Y.Z` run the complete quality gate, then build archives for:

- Linux x64 baseline (glibc and musl)
- Linux arm64 (glibc and musl)
- macOS x64
- macOS arm64

The workflow publishes all archives plus `SHA256SUMS`. It does not publish an npm version automatically.

## Security

The control socket is restricted to its owner and metrics bind to loopback. Treat the daemon as same-user administration, not as a remotely exposed control plane. See [SECURITY.md](./SECURITY.md) to report vulnerabilities privately.

## License

[MIT](./LICENSE)
