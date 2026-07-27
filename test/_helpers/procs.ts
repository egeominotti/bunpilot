// ---------------------------------------------------------------------------
// bunpilot – shared test process-lookup helpers
// ---------------------------------------------------------------------------
//
// Several suites need "which processes have <token> in their command line" so
// they can count or reap the children they spawned. Shelling out to `pgrep` /
// `pkill` makes those tests depend on procps being installed, which is true on
// the CI runners but not in a minimal container — and there the failure is a
// silent miscount rather than a clear skip.
//
// On Linux we read /proc directly (no subprocess at all); elsewhere we fall
// back to `ps`, and finally to `pgrep`. Mirrors what src/daemon/pid.ts does for
// the same reason.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';

/** PIDs whose full command line contains `token` (never includes this process). */
export function pidsMatching(token: string): number[] {
  const self = process.pid;
  const out: number[] = [];

  // `pid > 0` is load-bearing, not cosmetic: killMatching() feeds these to
  // process.kill, and pid 0 signals the whole PROCESS GROUP (which would take
  // the test runner down with it), while a negative pid signals another group.
  const usable = (pid: number): boolean => Number.isInteger(pid) && pid > 0 && pid !== self;

  if (process.platform === 'linux') {
    let entries: string[];
    try {
      entries = readdirSync('/proc');
    } catch {
      return out; // no procfs — nothing we can enumerate
    }
    for (const entry of entries) {
      const pid = Number.parseInt(entry, 10);
      if (!usable(pid)) continue;
      try {
        const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replaceAll('\0', ' ');
        if (cmdline.includes(token)) out.push(pid);
      } catch {
        // Process exited between readdir and read, or is not ours to inspect.
      }
    }
    return out;
  }

  // Bun.spawnSync THROWS when the binary is absent rather than returning
  // success:false, so both fallbacks must be guarded or the documented
  // pgrep fallback is unreachable.
  try {
    const ps = Bun.spawnSync(['ps', '-axo', 'pid=,command=']);
    if (ps.success) {
      for (const line of ps.stdout.toString().split('\n')) {
        if (!line.includes(token)) continue;
        const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10);
        if (usable(pid)) out.push(pid);
      }
      return out;
    }
  } catch {
    // No `ps` on this box — fall through to pgrep.
  }

  try {
    const pgrep = Bun.spawnSync(['pgrep', '-f', token]);
    if (!pgrep.success) return out;
    for (const line of pgrep.stdout.toString().split('\n')) {
      const pid = Number.parseInt(line.trim(), 10);
      if (usable(pid)) out.push(pid);
    }
  } catch {
    // Neither `ps` nor `pgrep` — caller gets an empty list.
  }
  return out;
}

/** SIGKILL every process whose command line contains `token`. Best effort. */
export function killMatching(token: string): void {
  for (const pid of pidsMatching(token)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}
