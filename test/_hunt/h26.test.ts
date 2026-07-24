// h26: a transient log-write failure must not permanently kill the pipe.
//
// Invariant: `LogManager.pipeStream` must keep consuming the child's stream for
// the worker's lifetime. A throw from `writer.write()` (ENOSPC / EACCES /
// EPERM while rotating) is transient; it must not exit the read loop, and it
// must never leave the child's stdout pipe undrained.

import { expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { LogManager } from '../../src/logs/manager';
import { rotatedLogPath } from '../../src/logs/writer';

// Deterministic PRNG (mulberry32) so failures are reproducible from the seed.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await tick();
}

/** Concatenated contents of every log file for the app. */
function readAllLogs(appDir: string): string {
  if (!existsSync(appDir)) return '';
  return readdirSync(appDir)
    .filter((n) => !n.startsWith('.'))
    .map((n) => {
      const p = join(appDir, n);
      try {
        return readFileSync(p, 'utf8');
      } catch {
        return '';
      }
    })
    .join('');
}

test('log pipe survives a transient write failure and keeps draining the stream', async () => {
  const SEEDS = [1, 7, 13, 42, 99, 2024];

  for (const seed of SEEDS) {
    const rand = prng(seed);
    const root = mkdtempSync(join('/private/tmp', 'bp-h26-'));
    const manager = new LogManager(root);

    let outCtl!: ReadableStreamDefaultController<Uint8Array>;
    let errCtl!: ReadableStreamDefaultController<Uint8Array>;
    const outStream = new ReadableStream<Uint8Array>({
      start(c) {
        outCtl = c;
      },
    });
    const errStream = new ReadableStream<Uint8Array>({
      start(c) {
        errCtl = c;
      },
    });

    const appName = `app${seed}`;
    const workerId = 0;
    const maxFiles = 3;
    const maxSize = 256 + Math.floor(rand() * 1024);
    const appDir = join(root, appName);
    const outLog = join(appDir, `${appName}-${workerId}-out.log`);

    const enc = new TextEncoder();
    const push = async (s: string) => {
      outCtl.enqueue(enc.encode(s));
      await settle();
    };

    try {
      manager.pipeOutput(appName, workerId, outStream, errStream, { maxSize, maxFiles }, false);

      // --- healthy phase: a few ordinary chunks, invariant holds after each step
      const warmup = 1 + Math.floor(rand() * 3);
      for (let i = 0; i < warmup; i++) {
        const line = `warm-${seed}-${i}\n`;
        await push(line);
        expect(readAllLogs(appDir)).toContain(line.trim());
        expect(outStream.locked).toBe(true);
      }

      // --- inject a transient fault: the oldest rotation slot is occupied by a
      // directory, so `unlinkSync` inside rotate() throws (EPERM/EISDIR).
      const blocker = rotatedLogPath(outLog, maxFiles);
      mkdirSync(blocker, { recursive: true });
      writeFileSync(join(blocker, 'occupied'), 'x');

      // Push enough to cross maxSize and force a rotation -> write() throws.
      await push('F'.repeat(maxSize + 16) + '\n');

      // --- fault clears 100ms later
      rmSync(blocker, { recursive: true, force: true });
      await settle();

      // The stream MUST still be consumed by the manager.
      expect(outStream.locked).toBe(true);

      // --- recovery: the live worker keeps logging
      const marker = `RECOVERED-${seed}`;
      await push(`${marker}\n`);

      expect(readAllLogs(appDir)).toContain(marker);
    } finally {
      try {
        outCtl.close();
      } catch {
        /* already closed */
      }
      try {
        errCtl.close();
      } catch {
        /* already closed */
      }
      await manager.closeAll();
      rmSync(root, { recursive: true, force: true });
    }
  }
}, 20000);
