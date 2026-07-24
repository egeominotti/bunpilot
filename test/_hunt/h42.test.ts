import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { validateApp } from '../../src/config/validator';
import { LogManager } from '../../src/logs/manager';
import { rotatedLogPath } from '../../src/logs/writer';

// ---------------------------------------------------------------------------
// CFG-006: a configured log path must never equal a *rotated* form
// (`name.N.ext`, N in 1..maxFiles) of the other configured log path.
// Rotation does renameSync(src, dst) unconditionally, so such a pair means one
// stream silently destroys the other stream's live log file.
//
// Property: for every logs config that validateApp() ACCEPTS, driving real
// LogWriters through one rotation must not destroy the peer stream's file.
// ---------------------------------------------------------------------------

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;

test('CFG-006: accepted log configs never let one stream rotate over the other', async () => {
  const root = mkdtempSync('/private/tmp/h42-');
  roots.push(root);

  const MARKER = 'IMPORTANT-PEER-STREAM-DATA';
  const MAX_SIZE = 1024;

  for (let seed = 1; seed <= 48; seed++) {
    const rng = mulberry32(seed);

    const base = pick(rng, ['app', 'svc', 'worker'] as const);
    const ext = pick(rng, ['.log', '.txt'] as const);
    const maxFiles = 1 + Math.floor(rng() * 5); // 1..5
    const rotIdx = 1 + Math.floor(rng() * maxFiles); // 1..maxFiles

    // `victim` is literally the rotated form of `rotator`.
    const rotator = `${base}${ext}`;
    const victim = rotatedLogPath(rotator, rotIdx);

    // Randomize which stream carries which file.
    const victimIsStdout = rng() < 0.5;
    const logs = {
      maxSize: MAX_SIZE,
      maxFiles,
      outFile: victimIsStdout ? victim : rotator,
      errFile: victimIsStdout ? rotator : victim,
    };

    let accepted = true;
    try {
      validateApp({ name: 'svc', script: 'server.ts', logs });
    } catch {
      accepted = false; // config layer rejected it — invariant upheld.
    }
    if (!accepted) continue;

    // Config was accepted: prove the runtime consequence.
    const appDir = join(root, `s${seed}`);
    const manager = new LogManager(appDir);
    const appName = 'svc';
    const { stdout, stderr } = manager.createWriters(appName, 0, logs);

    const victimWriter = victimIsStdout ? stdout : stderr;
    const rotatorWriter = victimIsStdout ? stderr : stdout;
    const victimPath = join(appDir, appName, victim);

    expect(victimWriter).not.toBe(rotatorWriter);

    await victimWriter.write(`${MARKER}\n`);
    expect(readFileSync(victimPath, 'utf8')).toContain(MARKER);

    // Push the peer stream past maxSize -> exactly one rotation.
    await rotatorWriter.write('R'.repeat(MAX_SIZE));

    await manager.closeAll();

    const survived = existsSync(victimPath) && readFileSync(victimPath, 'utf8').includes(MARKER);
    expect(
      survived,
      `seed=${seed} outFile=${logs.outFile} errFile=${logs.errFile} maxFiles=${maxFiles}: ` +
        `validateApp() accepted the config, then rotation of "${rotator}" destroyed "${victim}"`,
    ).toBe(true);
  }
});
