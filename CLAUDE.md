# CLAUDE.md

Guidelines for Claude Code when working on this project.

---

## Project Overview

**bunpm** is a Bun-native process manager (PM2 for Bun). It manages application lifecycle, clustering, health checks, metrics, and log rotation — all using Bun-native APIs with zero npm runtime dependencies.

- **Runtime:** Bun >= 1.0
- **Language:** TypeScript (strict mode)
- **Test framework:** `bun:test`
- **Build:** `bun build --compile` (single binary)

---

## Code Principles

- **DRY** — No duplicated logic. Extract shared code into helpers.
- **Clean code** — Small, focused functions. Descriptive names. No dead code.
- **Max 300–350 lines per file** — Split into sub-modules if a file exceeds this.
- **No npm runtime dependencies** — Use only Bun-native APIs (`Bun.spawn`, `Bun.serve`, `bun:sqlite`, etc.).
- **No over-engineering** — Only build what's needed. No speculative abstractions.

---

## Architecture

```
src/
├── index.ts              # CLI entry point
├── constants.ts          # Global constants & defaults
├── cli/                  # CLI argument parsing, commands, formatting
│   ├── index.ts          # parseArgs, extractEnv
│   ├── format.ts         # formatTable, formatUptime, formatMemory, etc.
│   └── commands/         # One file per command (start, stop, list, etc.)
├── config/               # Config loading & validation
│   ├── types.ts          # All TypeScript interfaces (AppConfig, BunpmConfig, etc.)
│   ├── loader.ts         # Config file discovery & loading
│   ├── validator.ts      # validateConfig, validateApp, resolveInstances
│   └── validate-helpers.ts  # Sub-validators (backoff, health, logs, etc.)
├── core/                 # Core daemon logic
│   ├── master.ts         # Master orchestrator
│   ├── process-manager.ts # Bun.spawn wrapper, kill, env building
│   ├── lifecycle.ts      # Worker state machine (spawning→online→stopped)
│   ├── backoff.ts        # CrashRecovery with exponential backoff
│   ├── worker-handler.ts # Per-worker event handling
│   ├── reload-handler.ts # Zero-downtime rolling restart
│   └── signals.ts        # SIGTERM/SIGINT handler
├── cluster/              # Clustering strategies
│   ├── platform.ts       # detectStrategy('auto'|'reusePort'|'proxy')
│   ├── reuse-port.ts     # Linux: kernel-level SO_REUSEPORT
│   └── proxy.ts          # macOS: TCP proxy with round-robin
├── control/              # CLI ↔ Daemon communication
│   ├── server.ts         # Unix socket server
│   ├── client.ts         # Unix socket client
│   ├── protocol.ts       # NDJSON encode/decode, createRequest/Response
│   └── handlers.ts       # Command handler dispatch
├── ipc/                  # Master ↔ Worker communication
│   ├── protocol.ts       # Message type guards
│   └── router.ts         # Message routing
├── health/checker.ts     # Heartbeat tracking + HTTP probes
├── metrics/
│   ├── aggregator.ts     # CPU/memory metrics aggregation
│   ├── prometheus.ts     # Prometheus exposition format
│   └── http-server.ts    # Metrics HTTP endpoint
├── logs/
│   ├── writer.ts         # LogWriter with size-based rotation
│   └── manager.ts        # LogManager (creates/pipes/closes writers)
├── daemon/
│   ├── daemonize.ts      # Background process spawning
│   └── pid.ts            # PID file read/write/cleanup
├── sdk/worker.ts         # Public API: bunpmReady, bunpmOnShutdown, bunpmStartMetrics
└── store/sqlite.ts       # SQLite persistence (apps, workers, metrics, restarts)
```

---

## Key Types

All domain types live in `src/config/types.ts`:

- `AppConfig` — Full app configuration with all fields
- `BunpmConfig` — Top-level config (`apps[]` + optional `daemon`)
- `WorkerState` — `'spawning' | 'starting' | 'online' | 'draining' | 'stopping' | 'stopped' | 'crashed' | 'errored'`
- `WorkerInfo` — Runtime worker state (pid, metrics, restart count)
- `WorkerMessage` / `MasterMessage` — IPC message types
- `ControlRequest` / `ControlResponse` — CLI ↔ Daemon protocol

---

## Commands

```bash
# Development
bun run dev               # Run CLI in dev mode
bun run typecheck         # TypeScript strict check
bun run lint              # ESLint (flat config, v9)
bun run lint:fix          # ESLint autofix
bun run format            # Prettier
bun run format:check      # Prettier check

# Testing
bun test                  # Run all 266 tests
bun test --watch          # Watch mode
bun test test/core/       # Run specific test directory

# Simulation
bun run scripts/simulate.ts           # Full module simulation (20 checks)
bun run scripts/simulate-cluster.ts   # Cluster simulation (14 checks)

# Build
bun run build             # Compile to single binary ./bunpm
```

---

## Testing

Tests live in `test/` mirroring `src/` structure:

```
test/
├── core/          lifecycle.test.ts, backoff.test.ts
├── config/        validator.test.ts, validate-helpers.test.ts
├── cli/           parser.test.ts, format.test.ts
├── store/         sqlite.test.ts
├── logs/          writer.test.ts, manager.test.ts (stub)
├── health/        checker.test.ts
├── metrics/       aggregator.test.ts, prometheus.test.ts
├── control/       protocol.test.ts
├── ipc/           protocol.test.ts
├── daemon/        pid.test.ts
└── cluster/       platform.test.ts, reuse-port.test.ts
```

- Use `bun:test` (`describe`, `test`, `expect`, `beforeEach`, `afterEach`)
- SQLite tests use `:memory:` databases
- File-system tests use `tmpdir()` with cleanup in `afterEach`
- No mocking of Bun-native APIs — test real behavior

---

## Conventions

### Imports
- Use relative imports within `src/`
- Types go in `src/config/types.ts`
- Constants/defaults go in `src/constants.ts`

### Error Handling
- Config validation throws descriptive `Error` with field path
- CLI commands use `logError()` from `src/cli/format.ts`
- Process manager catches `ESRCH` silently (process already dead)

### IPC Protocol
- CLI ↔ Daemon: NDJSON over Unix socket (`src/control/protocol.ts`)
- Master ↔ Worker: `Bun.spawn({ ipc })` with typed messages

### State Machine
Valid transitions are defined in `src/config/types.ts` (`TRANSITIONS` map). The `WorkerLifecycle` class in `src/core/lifecycle.ts` enforces them.

### Clustering
- `detectStrategy('auto')` returns `'reusePort'` on Linux, `'proxy'` on macOS
- ProxyCluster uses `Bun.listen` + `Bun.connect` for TCP forwarding
- Workers bind to internal ports (`INTERNAL_PORT_BASE + workerId`)

---

## Tooling

- **ESLint 9** — Flat config in `eslint.config.js` (not `.eslintrc`)
- **Prettier** — Config in `.prettierrc`
- **Husky** — Pre-commit hook runs typecheck + lint + format check
- **CI/CD** — GitHub Actions: check → test → build (`.github/workflows/ci.yml`)

---

## Common Pitfalls

- `Bun.listen` socket handlers are defined at the listener level, not per-socket. Use `socket.data` generic for per-connection state.
- `bun:sqlite` `unixepoch('now') * 1000` has second-level precision — add `id DESC` tiebreaker for deterministic ordering.
- `Bun.spawn(['bun', 'run', ...])` with `ipc` option — `proc.pid` is the spawned process PID.
- `fetch()` reuses TCP connections (HTTP keep-alive). Use `Connection: close` header when testing round-robin at the TCP level.
- ESLint 9 does not support `--ext .ts` flag or `.eslintignore` files — use `ignores` in flat config.
