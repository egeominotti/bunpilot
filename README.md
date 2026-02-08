# bunpilot

[![npm](https://img.shields.io/npm/v/bunpilot)](https://www.npmjs.com/package/bunpilot)
[![license](https://img.shields.io/npm/l/bunpilot)](./LICENSE)

**Bun-native process manager. PM2 for the Bun ecosystem.**

A process manager built from the ground up for [Bun](https://bun.sh) — zero npm runtime dependencies, single-binary distribution, and full leverage of Bun-native APIs (`Bun.spawn`, `Bun.serve`, `bun:sqlite`).

---

## Features

- **Clustering** — Automatic load balancing via `SO_REUSEPORT` (Linux) or TCP round-robin proxy (macOS)
- **Crash Recovery** — Exponential backoff with configurable restart limits and sliding windows
- **Zero-Downtime Reload** — Rolling restart replaces workers one at a time
- **Health Checks** — IPC heartbeat + HTTP probe with configurable thresholds
- **Metrics** — Built-in CPU/memory collection with Prometheus exposition format
- **Log Management** — Size-based rotation with configurable max files
- **Persistent State** — SQLite (WAL mode) stores apps, workers, restart history, and metrics
- **Graceful Shutdown** — Configurable signal + timeout with SIGKILL escalation
- **Daemon Mode** — Background process with Unix socket IPC (NDJSON protocol)
- **TypeScript Config** — First-class `bunpilot.config.ts` support with full type safety

---

## Requirements

- [Bun](https://bun.sh) >= 1.0

---

## Installation

```bash
# Install from npm
bun add -g bunpilot
```

Or build from source:

```bash
git clone https://github.com/egeominotti/bunpilot.git
cd bunpilot
bun install
bun run build    # Produces a single ./bunpilot binary
```

---

## Quick Start

### 1. Start a process

```bash
# Start a single script
bunpilot start ./src/server.ts --name api

# Start with clustering (4 workers)
bunpilot start ./src/server.ts --name api --instances 4 --port 3000

# Start from config file
bunpilot start --config bunpilot.config.ts
```

### 2. Manage processes

```bash
bunpilot list                # List all processes
bunpilot status api          # Detailed info for a specific app
bunpilot logs api            # Stream logs
bunpilot metrics             # Live CPU/memory dashboard
```

### 3. Lifecycle operations

```bash
bunpilot restart api         # Stop + start
bunpilot reload api          # Zero-downtime rolling restart
bunpilot stop api            # Graceful stop
bunpilot delete api          # Stop and remove
```

### 4. Daemon management

```bash
bunpilot daemon start        # Start the background daemon
bunpilot daemon stop         # Stop the daemon
bunpilot daemon status       # Check daemon health
bunpilot ping                # Verify daemon responsiveness
```

---

## Configuration

Generate an example config:

```bash
bunpilot init
```

This creates a `bunpilot.config.ts` file:

```typescript
import type { BunpilotConfig } from './src/config/types';

const config: BunpilotConfig = {
  apps: [
    {
      name: 'api-server',
      script: './src/server.ts',
      instances: 2,
      port: 3000,

      env: {
        NODE_ENV: 'production',
      },

      // Health checks
      healthCheck: {
        enabled: true,
        path: '/health',
        interval: 10_000,
        timeout: 5_000,
        unhealthyThreshold: 3,
      },

      // Restart policy
      maxRestarts: 15,
      maxRestartWindow: 60_000,
      minUptime: 5_000,
      backoff: { initial: 1_000, multiplier: 2, max: 30_000 },

      // Graceful shutdown
      shutdownSignal: 'SIGTERM',
      killTimeout: 8_000,
      readyTimeout: 10_000,

      // Log rotation
      logs: {
        outFile: './logs/api-out.log',
        errFile: './logs/api-err.log',
        maxSize: 10 * 1024 * 1024,  // 10 MB
        maxFiles: 5,
      },

      // Metrics
      metrics: {
        enabled: true,
        prometheus: false,
        collectInterval: 5_000,
      },

      // Clustering
      clustering: {
        enabled: true,
        strategy: 'reusePort',
        rollingRestart: { batchSize: 1, batchDelay: 2_000 },
      },
    },
  ],

  daemon: {
    pidFile: './bunpilot.pid',
    socketFile: './bunpilot.sock',
    logFile: './logs/bunpilot-daemon.log',
  },
};

export default config;
```

### Configuration Reference

| Option | Type | Default | Description |
|---|---|---|---|
| `name` | `string` | *required* | Application name |
| `script` | `string` | *required* | Entry point path |
| `instances` | `number \| 'max'` | `1` | Worker count (`'max'` = CPU cores) |
| `port` | `number` | — | Base port for workers |
| `env` | `Record<string, string>` | — | Environment variables |
| `cwd` | `string` | `process.cwd()` | Working directory |
| `interpreter` | `string` | — | Custom interpreter (default: `bun`) |
| `maxRestarts` | `number` | `15` | Max restarts within window |
| `maxRestartWindow` | `number` | `900_000` | Restart window in ms (15 min) |
| `minUptime` | `number` | `30_000` | Min uptime to reset crash counter (ms) |
| `killTimeout` | `number` | `5_000` | Force-kill timeout (ms) |
| `shutdownSignal` | `'SIGTERM' \| 'SIGINT'` | `'SIGTERM'` | Graceful shutdown signal |
| `readyTimeout` | `number` | `30_000` | Max wait for `bunpilotReady()` (ms) |

### Clustering Strategies

| Strategy | Platform | How It Works |
|---|---|---|
| `reusePort` | Linux | Kernel distributes connections via `SO_REUSEPORT` |
| `proxy` | macOS / fallback | Master runs a TCP proxy with round-robin |
| `auto` | Any | Detects platform and picks the best strategy |

---

## Worker SDK

Integrate your application with bunpilot using the worker SDK:

```typescript
import { bunpilotReady, bunpilotOnShutdown, bunpilotStartMetrics } from 'bunpilot/worker';

// Start your server
const server = Bun.serve({
  port: process.env.BUNPILOT_PORT ?? 3000,
  fetch(req) {
    return new Response('Hello!');
  },
});

// Signal that the worker is ready to accept traffic
bunpilotReady();

// Start periodic metrics reporting (every 5s)
bunpilotStartMetrics(5_000);

// Handle graceful shutdown
bunpilotOnShutdown(async () => {
  server.stop(true);
});
```

### SDK API

| Function | Description |
|---|---|
| `bunpilotReady()` | Notify master that the worker is online and ready |
| `bunpilotOnShutdown(handler)` | Register async cleanup handler for graceful shutdown |
| `bunpilotStartMetrics(interval?)` | Start periodic CPU/memory reporting (default: 5000ms) |

### Worker Environment Variables

bunpilot injects these environment variables into each worker:

| Variable | Description |
|---|---|
| `BUNPILOT_WORKER_ID` | Worker index (0-based) |
| `BUNPILOT_PORT` | Port the worker should bind to |
| `BUNPILOT_REUSE_PORT` | `'1'` if using `reusePort` strategy |
| `BUNPILOT_APP_NAME` | Application name |
| `BUNPILOT_INSTANCES` | Total number of instances |

---

## CLI Reference

```
bunpilot — Bun-native process manager

Usage:
  bunpilot <command> [args] [flags]

Process Commands:
  start <script|config>      Start a process (or cluster)
  stop <name|all>            Stop a running process
  restart <name|all>         Restart a process (stop + start)
  reload <name|all>          Gracefully reload (zero-downtime)
  delete <name|all>          Stop and remove a process

Inspection Commands:
  list                       List all managed processes
  status <name>              Show detailed process info
  logs [name]                Stream process log output
  metrics                    Live CPU / memory dashboard

Daemon Commands:
  daemon <start|stop|status> Manage the background daemon
  ping                       Check if the daemon is alive

Other:
  init                       Generate a config file template

Global Flags:
  --help, -h                 Show help
  --version, -v              Show version
  --json                     Output as JSON
  --force                    Force the operation
  --prometheus               Export metrics in Prometheus format
```

---

## Metrics & Monitoring

### Prometheus Export

Enable Prometheus scraping on port 9615 (default):

```typescript
metrics: {
  enabled: true,
  prometheus: true,
  httpPort: 9615,
  collectInterval: 5_000,
}
```

Exposed metrics:

```
bunpilot_worker_memory_rss_bytes{app="api-server",worker="0"} 52428800
bunpilot_worker_memory_heap_used_bytes{app="api-server",worker="0"} 31457280
bunpilot_worker_cpu_percent{app="api-server",worker="0"} 2.5
bunpilot_worker_restart_count{app="api-server",worker="0"} 0
bunpilot_master_uptime_seconds{app="api-server"} 3600
```

### CLI Dashboard

```bash
bunpilot metrics              # Table view
bunpilot metrics --json       # JSON output
bunpilot metrics --prometheus # Prometheus format
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   bunpilot CLI                       │
│         (Unix socket + NDJSON protocol)           │
└──────────────┬───────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────┐
│              Master Daemon                        │
│  ┌─────────┐ ┌──────────┐ ┌───────────────────┐  │
│  │ Control │ │ Lifecycle │ │  Crash Recovery   │  │
│  │ Server  │ │  State    │ │  (exp. backoff)   │  │
│  └─────────┘ │ Machine   │ └───────────────────┘  │
│              └──────────┘                         │
│  ┌──────────┐ ┌─────────┐ ┌───────────────────┐  │
│  │ Process  │ │ Health  │ │  Metrics          │  │
│  │ Manager  │ │ Checker │ │  Aggregator       │  │
│  └────┬─────┘ └─────────┘ └───────────────────┘  │
│       │   ┌────────────┐  ┌───────────────────┐  │
│       │   │ SQLite     │  │  Log Manager      │  │
│       │   │ Store      │  │  (rotation)       │  │
│       │   └────────────┘  └───────────────────┘  │
└───────┼──────────────────────────────────────────┘
        │ Bun.spawn (IPC)
   ┌────▼─────┐  ┌──────────┐  ┌──────────┐
   │ Worker 0 │  │ Worker 1 │  │ Worker N │
   │  :3000   │  │  :3000   │  │  :3000   │
   └──────────┘  └──────────┘  └──────────┘
```

### Worker Lifecycle

```
spawning → starting → online → draining → stopping → stopped
                        │                               ↑
                        └──── crashed ──── spawning ─────┘
```

---

## Development

```bash
# Install dependencies
bun install

# Run in development
bun run dev

# Type checking
bun run typecheck

# Linting & formatting
bun run lint
bun run lint:fix
bun run format
bun run format:check

# Run tests (266 tests)
bun test

# Run tests in watch mode
bun test --watch

# Run simulation
bun run scripts/simulate.ts

# Run cluster simulation
bun run scripts/simulate-cluster.ts

# Build single binary
bun run build
```

### Project Structure

```
src/
├── index.ts              # CLI entry point
├── constants.ts          # Global constants & defaults
├── cli/                  # CLI commands & formatting
├── config/               # Config loading & validation
├── core/                 # Master, process manager, lifecycle
├── cluster/              # reusePort & proxy strategies
├── control/              # Unix socket server/client (NDJSON)
├── daemon/               # Daemonization & PID management
├── health/               # Health check system
├── ipc/                  # Inter-process communication
├── logs/                 # Log writer & rotation
├── metrics/              # Aggregator & Prometheus export
├── sdk/                  # Public worker SDK
└── store/                # SQLite persistence
```

---

## License

MIT
