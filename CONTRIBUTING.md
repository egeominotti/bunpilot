# Contributing

Read [AGENTS.md](./AGENTS.md) before making changes. It defines the architecture, safety invariants, required checks, and release policy.

Use a focused branch and include a regression test with each bug fix. Use Biome only; do not add ESLint or Prettier. Sequence-dependent behavior needs deterministic model-based coverage in addition to focused unit or integration tests.

Before opening a pull request, run:

```bash
npm ci --ignore-scripts
bun run check
bun run typecheck
bun test
bun run simulate
bun run simulate:cluster
bun run build
./bunpilot --version
```

Explain the user-visible behavior, the invariant protected by the change, and the verification performed. Do not include generated binaries, runtime state, logs, sockets, databases, local configs, or coverage output.
