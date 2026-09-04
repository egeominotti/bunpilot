# Bunpilot repository instructions

Read and follow [AGENTS.md](./AGENTS.md) before changing code. It is authoritative for
architecture, lifecycle and isolation invariants, validation, and release policy. Use
[SKILL.md](./SKILL.md) when applying the repository workflow in an agent environment.

Use Bun 1.4.1 exactly. Keep `packageManager`, `engines`, `bun-types`, GitHub Actions, and
release builds on that version. This project is strict TypeScript, ESM-only, and supports
macOS and Linux on arm64 and x64.

Use Oxfmt for formatting and Oxlint for linting. Use fast-check for property-based and
model-based tests, with explicit replayable seeds and run counts. Continue to use
`bun:test` as the test runner. Do not add another formatter, linter, or test runner.

Before declaring a change complete, run `bun run check`, both TypeScript checks, the
focused tests, the complete test suite, both simulations, the version check, a native
build, and the binary version smoke test. Never commit generated binaries, profiles,
coverage, logs, sockets, databases, or other runtime state.
