// ---------------------------------------------------------------------------
// h48 – Untrusted IPC metrics payload must not leak extra keys into state
// ---------------------------------------------------------------------------
//
// Invariant (AGENTS.md): "Config, IPC, PID files, app names, and log filenames
// are untrusted input" / "Frames ... remain bounded, and malformed input must
// fail closed." Only the validated fields of an IPC metrics payload may enter
// orchestrator state (WorkerInfo.memory), because that state is re-serialized
// into every control-plane response (list/status/metrics/dump) which is hard
// capped at MAX_CONTROL_FRAME_BYTES.
// ---------------------------------------------------------------------------

import { expect, test } from 'bun:test';
import type { AppConfig, WorkerInfo, WorkerMessage } from '../../src/config/types';
import { MAX_CONTROL_FRAME_BYTES } from '../../src/control/protocol';
import { toAppStatus } from '../../src/core/app-status';
import { CrashRecovery } from '../../src/core/backoff';
import { WorkerLifecycle } from '../../src/core/lifecycle';
import type { ProcessManager } from '../../src/core/process-manager';
import { type ManagedApp, WorkerHandler } from '../../src/core/worker-handler';
import { isValidWorkerMessage } from '../../src/ipc/protocol';

// --- seeded deterministic PRNG (mulberry32) --------------------------------

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- fixtures ---------------------------------------------------------------

function makeConfig(): AppConfig {
  return {
    name: 'h48-app',
    script: 'app.ts',
    instances: 1,
    maxRestarts: 3,
    maxRestartWindow: 60_000,
    minUptime: 1_000,
    killTimeout: 5_000,
    shutdownSignal: 'SIGTERM',
    readyTimeout: 30_000,
    backoff: { initial: 1_000, multiplier: 2, max: 30_000 },
  };
}

function makeWorker(id: number): WorkerInfo {
  return {
    id,
    pid: 1000 + id,
    state: 'online',
    startedAt: Date.now(),
    readyAt: Date.now(),
    restartCount: 0,
    consecutiveCrashes: 0,
    lastCrashAt: null,
    exitCode: null,
    signalCode: null,
    memory: null,
    cpu: null,
  };
}

function makeManagedApp(workers: WorkerInfo[]): ManagedApp {
  return {
    config: makeConfig(),
    workers,
    spawned: new Map(),
    startedAt: Date.now(),
    stableTimers: new Map(),
    readyTimers: new Map(),
    workerPorts: new Map(),
    launchTokens: new Map(),
    restartingWorkers: new Set(),
    stopping: false,
    nextWorkerId: workers.length,
  };
}

function makeHandler(): WorkerHandler {
  const pm = {
    killWorker: async () => {},
  } as unknown as ProcessManager;
  return new WorkerHandler(pm, new CrashRecovery(), new WorkerLifecycle());
}

// `arrayBuffers` is a validated MemoryMetrics field (process.memoryUsage), not
// an injected key — it is part of the accepted contract alongside the rest.
const ALLOWED_MEMORY_KEYS = [
  'arrayBuffers',
  'external',
  'heapTotal',
  'heapUsed',
  'rss',
  'timestamp',
];

// ---------------------------------------------------------------------------
// Property: for any accepted metrics message, worker.memory carries exactly the
// validated fields (+ timestamp), and the control-plane view stays encodable.
// ---------------------------------------------------------------------------

test('h48: hostile IPC metrics payload cannot inject unvalidated keys into worker state', () => {
  const junkNames = ['pad', 'blob', '__proto__x', 'note', 'x'];

  for (let seed = 1; seed <= 60; seed++) {
    const rng = makeRng(seed);
    const workerCount = 1 + Math.floor(rng() * 3);
    const workers = Array.from({ length: workerCount }, (_, i) => makeWorker(i));
    const managed = makeManagedApp(workers);
    const handler = makeHandler();

    for (const worker of workers) {
      // Junk sized so a handful of workers blow past the 1 MiB control frame
      // cap, mirroring the "many workers, no single oversized message" case.
      const junkLen = 400_000 + Math.floor(rng() * 200_000);
      const junkKey = junkNames[Math.floor(rng() * junkNames.length)] as string;

      const payload = {
        memory: {
          rss: Math.floor(rng() * 1000),
          heapTotal: Math.floor(rng() * 1000),
          heapUsed: Math.floor(rng() * 1000),
          external: Math.floor(rng() * 1000),
          [junkKey]: 'A'.repeat(junkLen),
        },
        cpu: { user: Math.floor(rng() * 100), system: Math.floor(rng() * 100) },
      };
      const msg = { type: 'metrics', payload } as unknown as WorkerMessage;

      // Precondition: the message really is accepted by the IPC validator, so
      // handleMessage is the layer responsible for not trusting extra keys.
      expect(isValidWorkerMessage(msg)).toBe(true);

      handler.handleMessage(managed, worker.id, msg);

      const keys = Object.keys(worker.memory ?? {}).sort();
      expect(
        keys,
        `seed=${seed} worker=${worker.id} junkKey=${junkKey}: unvalidated key leaked into worker.memory`,
      ).toEqual(ALLOWED_MEMORY_KEYS);
    }

    // The derived control-plane payload must stay inside the frame budget that
    // ControlServer.encodeBoundedResponse enforces; otherwise list/status/
    // metrics/dump all fail closed for the operator.
    const encoded = new TextEncoder().encode(JSON.stringify(toAppStatus(managed))).byteLength;
    expect(
      encoded,
      `seed=${seed}: AppStatus frame is ${encoded} bytes, over MAX_CONTROL_FRAME_BYTES`,
    ).toBeLessThan(MAX_CONTROL_FRAME_BYTES);
  }
});
