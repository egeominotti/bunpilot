---
name: bunpilot
description: Develop, debug, test, harden, document, and release the Bunpilot Bun-native process manager. Use when changing this repository's worker lifecycle, clustering, daemon control, IPC, configuration, logging, metrics, SQLite persistence, worker SDK, CI, or cross-platform release automation.
---

# Work on Bunpilot

Read `AGENTS.md` and inspect the affected module plus its tests before editing.

Reproduce bugs with focused regression tests. Preserve app-level isolation, valid lifecycle transitions, generation safety, bounded untrusted input, collision-free ports, retryable rollback, and idempotent cleanup.

Use Biome for formatting, linting, and import organization. Do not introduce ESLint or Prettier. Keep strict TypeScript and avoid runtime dependencies unless the change cannot be implemented safely with Bun or Node built-ins.

Add deterministic model-based tests when behavior depends on long event sequences. Maintain an independent reference model and assert invariants after each seeded operation. Use integration tests for real sockets, subprocesses, proxy traffic, SQLite, and log I/O.

Validate narrowly while iterating, then run:

```bash
bun run check
bun run typecheck
bun test
bun run simulate
bun run simulate:cluster
bun run version:check
bun run build
./bunpilot --version
```

Review the diff, generated files, dependency audit, and release metadata. Keep `src/version.ts`, `package.json`, changelog entries, and release tags synchronized. Put compiled executables in release artifacts, never in Git.
