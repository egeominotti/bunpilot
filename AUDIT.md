# Deep Bug Hunt Audit

Audit date: 2026-07-23. Scope: handwritten TypeScript/Bun sources; generated and vendored files excluded.

## Pass 0 — ground truth

The repository is a TypeScript CLI/daemon built with Bun 1.4.1, using Bun's test runner and `tsc --noEmit` for type checking. Oxfmt and Oxlint provide formatting and linting. Build scripts use `bun build --compile`; GitHub Actions provides Linux/macOS matrices and release artifacts. The critical modules are configuration validation, daemon boot/PID/socket lifecycle, master/worker lifecycle and reload, process management, proxy/port allocation, health checks, IPC/control framing, persistence, and log/metrics output.

Property and model-based tests use fast-check with reproducible seeds and paths. Stryker is not Bun-native, so five plausible mutations were applied manually and reverted after each run.

## Pass 1 — extracted invariants

1. A restart window is inclusive at expiry; crash counters reset exactly at the boundary.
2. Health checks start only after a worker is online, explicitly enabled, and has a reachable bound port.
3. A failed start/reload is transactional: no ghost worker, port, proxy, timer, or monitor remains.
4. A kill operation reports success only after the process has exited.
5. PID cleanup cannot remove a newer daemon's PID file, and PID reuse must not identify an unrelated process as bunpilot.
6. A control socket path is never clobbered while active and regular files are never deleted.
7. Control frames are bounded and every client request receives a finite response.
8. Prometheus labels are valid escaped strings.
9. App names and derived paths are bounded, control-free, portable, and unique.
10. Daemon metrics/public/worker ports and runtime paths are pairwise disjoint.
11. Runtime state and secrets are owner-only on disk.
12. Log follow preserves every appended line, including duplicate text.
13. Shutdown drains in-flight log streams before closing writers.
14. A workerless status with timestamp zero is still running when `startedAt !== null`.
15. Model transitions conserve worker count, ports, and lifecycle state across arbitrary operation sequences.

## Pass 2/3 — findings and executable proofs

### 1. High — restart-window boundary

**File:line:** `src/core/backoff.ts:34`

**Invariant violated:** #1.

**Scenario:** with `maxRestartWindow = 1000`, a second crash at exactly `windowStart + 1000` was counted in the old window and returned `give-up` instead of restarting.

**Reproducing test:** `test/core/backoff.test.ts` (exact expiry case); the pre-fix run failed, while the fixed run passes.

**Minimal fix:** reset on `>=`, not `>`.

### 2. High — health checks could start for unready/unbound/disabled workers

**File:line:** `src/core/worker-launch.ts:139-144`

**Invariant violated:** #2.

**Scenario:** a `ready` message for a worker without a public or allocated internal port, or with `healthCheck.enabled = false`, started a checker; starting before the online transition also raced readiness.

**Reproducing test:** `test/core/master.test.ts` (`only after each worker is ready`, `health explicitly disabled`); pre-fix assertions failed.

**Minimal fix:** require the online transition, `enabled`, and `(config.port !== undefined || workerPorts.has(wid))`.

### 3. High — reload was not transactional

**File:line:** `src/core/master.ts:224-290`

**Invariant violated:** #3.

**Scenario:** synchronous replacement spawn failure or a failed old-worker drain left an online replacement, allocated port, proxy slot, or monitor while the old worker remained/was removed inconsistently.

**Reproducing test:** `test/core/master-reload.test.ts` (`synchronous replacement spawn failure`, `failed old-worker drain`); both failed before the transaction/rollback fix.

**Minimal fix:** track uncommitted replacements and retire/restore them on every failed reload path.

### 4. High — `killWorker` reported killed before exit

**File:line:** `src/core/process-manager.ts`

**Invariant violated:** #4.

**Scenario:** a process ignoring SIGTERM was reported `killed` immediately after SIGKILL even though it was still alive, allowing an immediate replacement to race for its port.

**Reproducing test:** `test/core/process-manager.test.ts` (`rejects when process is still alive after SIGKILL`); pre-fix run observed a false success.

**Minimal fix:** poll after SIGKILL and reject if the process remains alive.

### 5. High — PID file TOCTOU

**File:line:** `src/daemon/pid.ts:34-43`

**Invariant violated:** #5.

**Scenario:** daemon A read PID 111, daemon B replaced the file with PID 222, then A unconditionally unlinked B's PID file.

**Reproducing test:** `test/daemon/pid.test.ts` (`replacement daemon`); pre-fix expected 222 but read null.

**Minimal fix:** remove only when the file still contains the expected PID.

### 6. High — PID reuse trusted an unrelated process

**File:line:** `src/daemon/pid.ts:66-96`

**Invariant violated:** #5.

**Scenario:** a reused PID belonged to a command whose arguments merely contained `bunpilot`; the old code accepted it as the daemon.

**Reproducing test:** `test/daemon/pid.test.ts` (`unrelated process`); pre-fix identity check returned true.

**Minimal fix:** require the daemon marker and a bunpilot/boot executable identity.

### 7. High — control socket clobbering

**File:line:** `src/control/server.ts:169-198`

**Invariant violated:** #6.

**Scenario:** startup unlinked a regular file or an active socket at the configured path, destroying unrelated data or a live daemon endpoint.

**Reproducing test:** `test/control/server.test.ts` (`regular file`, `second server`); both pre-fix runs unexpectedly succeeded.

**Minimal fix:** reject non-sockets and reachable sockets; unlink only stale sockets and remove only the owned inode.

### 8. High — oversized control response hung clients

**File:line:** `src/control/server.ts:201-213`

**Invariant violated:** #7.

**Scenario:** a handler returned a multi-megabyte object; the server emitted an oversized NDJSON frame and the client waited until timeout.

**Reproducing test:** `test/control/server.test.ts` (`oversized handler response`); pre-fix run timed out after 5000 ms.

**Minimal fix:** enforce a byte limit and return a bounded error frame.

### 9. Medium — invalid Prometheus label escaping

**File:line:** `src/cli/commands/metrics.ts`

**Invariant violated:** #8.

**Scenario:** an app name containing `"`, `\\`, or a newline produced invalid exposition syntax and could corrupt a scrape.

**Reproducing test:** `test/cli/commands/commands2.test.ts` (special-character labels); pre-fix output was malformed.

**Minimal fix:** escape backslash, quote, and newline before interpolation.

### 10. Medium — config name/path boundary and Windows derivation

**File:line:** `src/config/validator.ts`, `src/config/loader.ts`

**Invariant violated:** #9.

**Scenario:** a 129-character or control-containing app name passed validation; a Windows script path derived a name containing `C:` and backslashes.

**Reproducing test:** `test/config/validator.test.ts`, `test/config/loader.test.ts`; pre-fix cases were accepted/derived incorrectly.

**Minimal fix:** cap names at 128, reject Unicode controls, and split both `/` and `\\` when deriving names.

### 11. High — daemon port collisions

**File:line:** `src/config/validator.ts`, `src/core/master.ts`, `src/daemon/boot.ts`

**Invariant violated:** #10.

**Scenario:** an app used default metrics port 9615 as its public port, or proxy allocation selected a daemon-reserved port, causing bind failure or traffic theft.

**Reproducing test:** `test/config/validator.test.ts`, `test/core/master.test.ts`, `test/daemon/boot.test.ts`; pre-fix cases were accepted.

**Minimal fix:** validate static/dynamic app compatibility and seed the allocator with daemon-reserved ports.

### 12. High — aliased daemon paths

**File:line:** `src/daemon/paths.ts`

**Invariant violated:** #10.

**Scenario:** PID, socket, and log paths resolving to the same filesystem path caused cleanup or writes to target the wrong artifact.

**Reproducing test:** `test/daemon/paths.test.ts`; pre-fix aliases were accepted.

**Minimal fix:** compare normalized resolved paths and reject duplicates.

### 13. High — runtime files were too permissive

**File:line:** `src/store/sqlite.ts`, `src/daemon/pid.ts`, `src/logs/writer.ts`

**Invariant violated:** #11.

**Scenario:** umask 000 allowed other users to read the database, PID, or logs containing environment-derived secrets.

**Reproducing test:** `test/store/sqlite.test.ts`, `test/daemon/pid.test.ts`, `test/logs/writer.test.ts`; pre-fix modes were world-readable.

**Minimal fix:** directories mode 0700 and files mode 0600, including existing files.

### 14. Medium — log follow dropped duplicate appended lines

**File:line:** `src/cli/commands/logs.ts`

**Invariant violated:** #12.

**Scenario:** two successive polls ended with the same text line; last-line deduplication suppressed the newly appended event.

**Reproducing test:** `test/cli/log-follow.test.ts`; pre-fix emitted only one line.

**Minimal fix:** retain the previous full snapshot and remove only the longest recognizable suffix overlap.

### 15. Medium — shutdown closed writers before stream drains

**File:line:** `src/logs/manager.ts`

**Invariant violated:** #13.

**Scenario:** a delayed stdout pipe still had bytes in flight when `closeAll()` closed writers, losing tail log data.

**Reproducing test:** `test/logs/manager.test.ts` (`closeAll drains an in-flight stream`); pre-fix tail data was lost.

**Minimal fix:** track pipe promises, drain them with a bounded timeout, then close writers.

Additional regression coverage fixed epoch-zero status, log filename collisions, and metrics/public path collisions.

## Pass 4 — mutation testing

| Mutation                               | Result                                                               |
| -------------------------------------- | -------------------------------------------------------------------- |
| `>=` → `>` in restart window           | Caught by `test/core/backoff.test.ts`                                |
| readiness predicate inverted           | Caught by `test/core/master.test.ts`                                 |
| remove PID expected-value guard        | Caught by `test/daemon/pid.test.ts`                                  |
| control response size check removed    | Caught by `test/control/server.test.ts` timeout                      |
| proxy pending-buffer overflow disabled | **Survived** existing tests; restored and recorded as a coverage gap |

The invariant/model suite executes 291k+ assertions. Final CI ran 1,130 tests with 0 failures; coverage was 91.33% functions and 93.34% lines.
