# Bunpilot contributor guide

This repository ships a Bun-native process manager and a zero-runtime-dependency worker SDK. Treat process lifecycle, IPC, persistence, ports, and log paths as production-critical code.

## Supported environment

- Bun 1.3.14 or newer in the 1.3 line
- macOS and Linux, on x64 and arm64
- TypeScript in strict mode, ESM only
- Unix-domain sockets for daemon control

Do not claim Windows support unless the control transport, daemon lifecycle, signal handling, tests, and release smoke tests all support it.

## Required workflow

1. Read the closest `AGENTS.md` and the root `SKILL.md` before changing code.
2. Inspect the affected production module and its existing tests.
3. Reproduce a defect with a regression test before or alongside the fix.
4. Preserve lifecycle and isolation invariants listed below.
5. Run the narrow tests while iterating.
6. Run `bun run ci`, both simulations when their surfaces changed, and a binary smoke test before declaring the work complete.
7. Review `git diff --check`, `git status`, generated files, and dependency audit output before committing.

Never commit local runtime data, generated configs, databases, sockets, logs, coverage, or compiled binaries. Release binaries belong in GitHub release artifacts.

## Commands

```bash
npm ci --ignore-scripts     # deterministic dependency install from package-lock.json
bun run check               # Biome format, lint, and import checks
bun run check:fix           # apply safe Biome fixes
bun run typecheck           # strict TypeScript validation
bun test                    # complete unit, integration, regression, and model suite
bun run test:model          # deterministic model-based invariant suite
bun run test:coverage       # coverage report and coverage/lcov.info
bun run simulate            # module-level integration simulation
bun run simulate:cluster    # real worker/proxy round-robin simulation
bun run version:check       # package/source version consistency
bun run build               # native single executable
```

Use Biome only. Do not reintroduce ESLint, Prettier, their configs, or their dependencies.

## Architecture map

- `src/index.ts`: CLI executable and lazy command router
- `src/public.ts`: side-effect-free package API
- `src/cli/`: argument parsing, output, and daemon-facing commands
- `src/config/`: types, loading, defaults, and untrusted-input validation
- `src/control/`: bounded NDJSON framing and control socket client/server
- `src/core/`: orchestrator, process lifecycle, restart, and rolling reload logic
- `src/cluster/`: reuse-port policy and userland TCP proxy
- `src/health/`: namespaced HTTP and heartbeat liveness checks
- `src/logs/`: safe paths, bounded tail reading, writers, and rotation
- `src/metrics/`: aggregation, HTTP serving, and Prometheus formatting
- `src/daemon/`: detached boot, PID safety, persistence restore, and cleanup
- `src/store/`: SQLite desired state and history
- `src/sdk/`: public worker readiness, heartbeat, metrics, and shutdown hooks
- `test/model/`: long deterministic state-machine and framing sequences

## Non-negotiable invariants

- A worker state changes only along `TRANSITIONS`; shutdown may force a final stopped state only after process termination is authoritative.
- Worker IDs are scoped by app. Health, heartbeat, crash recovery, timers, launch generations, logs, and ports must not leak across apps.
- At most one lifecycle mutation runs for a given app at once. Different apps may progress independently.
- A late message or exit from an old process generation must never mutate its replacement.
- A stopped or deleting app must not be resurrected by health, heartbeat, readiness, or crash timers.
- A hard restart kills and awaits the old process before binding its replacement; rolling reload keeps old capacity until a replacement is online.
- Public and internal ports are globally collision-free for the daemon and are released on stop, delete, rollback, and retirement.
- Control responses are correlated by request ID. Frames and proxy pre-connect buffers remain bounded, and malformed input must fail closed.
- Config, IPC, PID files, app names, and log filenames are untrusted input. Reject traversal, NULs, invalid numbers, and unsafe process IDs.
- Persistence reflects successful lifecycle transitions. Failed starts/restarts remain retryable and must not leave stale locks or desired state.
- Log rotation naming is `name.N.log`; readers return bounded tails and never escape the per-app directory.
- Returned status/config/metric objects are snapshots, not references to mutable orchestrator state.
- Shutdown is idempotent and attempts cleanup for every app and registered resource even if one cleanup fails.

## Testing expectations

For ordinary logic, add focused unit tests. For sockets, processes, proxying, SQLite, and log I/O, add integration tests with unique temporary paths and ports and guaranteed cleanup.

When behavior is a state machine or sequence-dependent, add or extend a deterministic model-based test. Generate long operation sequences from a seeded PRNG, maintain a small independent reference model, and assert invariants after every operation. A failing seed must be printed or statically reproducible. Never replace model tests with random smoke tests.

Tests must not rely on ordering across files, real user state under `~/.bunpilot`, fixed occupied ports, network access, or sleeps longer than needed. Restore monkey-patched globals and kill spawned processes in cleanup hooks.

## Releases

`src/version.ts`, `package.json`, and the Git tag must agree. Run `bun run version:check vX.Y.Z`. Tags matching `v*` invoke the release workflow, which reruns quality gates, cross-compiles supported targets, smoke-tests native binaries, creates checksums, and publishes GitHub release artifacts.

Do not manually commit a release executable. Do not push a version tag until the main-branch CI is green and the changelog contains that version.
