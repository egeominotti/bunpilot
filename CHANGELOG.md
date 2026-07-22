# Changelog

All notable changes follow [Semantic Versioning](https://semver.org/).

## 1.0.0 - 2026-07-22

### Added

- Deterministic model-based invariant tests for lifecycle, crash backoff, isolation, and UTF-8 NDJSON framing.
- Side-effect-free public package entry point and centralized version checks.
- Linux/macOS CI, coverage artifacts, integration simulations, dependency auditing, and Dependabot updates.
- Cross-compiled GitHub releases for macOS and glibc/musl Linux on x64 and arm64, with SHA-256 checksums.
- Repository-specific `AGENTS.md` and reusable `SKILL.md` operating guidance.

### Changed

- Replaced ESLint and Prettier with Biome 2.
- Promoted the project to the stable 1.0 API and documented the supported platform contract.
- Made daemon PID, socket, and log paths effective and made PID publication a readiness signal.

### Fixed

- Worker-generation races, duplicate restart triggers, readiness timeouts, cross-app health/backoff collisions, and restart rollback deadlocks.
- Internal/public port collisions, proxy pending-buffer growth, replacement-worker routing, and stopped-app resurrection.
- Malformed IPC/control input, response correlation, split UTF-8 frames, unbounded control frames, unsafe PID parsing, and log path traversal.
- Rotation writer/reader filename mismatch, nested custom logs, fragmented console lines, duplicate log writers, and unbounded log-tail reads.
- SQLite NULL transitions and timestamp precision, config default gaps, unsafe numeric values, state restoration, and cleanup idempotency.
