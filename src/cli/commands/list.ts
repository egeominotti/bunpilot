// ---------------------------------------------------------------------------
// bunpilot – CLI Command: list
// ---------------------------------------------------------------------------
//
// List all managed applications with a summary table showing status,
// resource usage, and uptime per worker.
// ---------------------------------------------------------------------------

import { sendCommand } from './_connect';
import { formatTable, formatUptime, formatMemory, formatState, logWarn } from '../format';
import type { AppStatus, WorkerInfo } from '../../config/types';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function listCommand(
  _args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const res = await sendCommand('list', undefined, { silent: true });
  const apps = (res.data ?? []) as AppStatus[];

  // ---- JSON output ----
  if (flags.json) {
    console.log(JSON.stringify(apps, null, 2));
    return;
  }

  // ---- Empty state ----
  if (apps.length === 0) {
    logWarn('No applications running');
    return;
  }

  // ---- Table output ----
  const headers = ['NAME', 'STATUS', 'PID', 'CPU', 'MEM', 'UPTIME', 'RESTARTS'];
  const rows: string[][] = [];

  for (const app of apps) {
    if (app.workers.length === 0) {
      rows.push([
        app.name,
        formatState(
          app.status === 'running' ? 'online' : app.status === 'errored' ? 'errored' : 'stopped',
        ),
        '\u2014',
        '\u2014',
        '\u2014',
        '\u2014',
        '0',
      ]);
      continue;
    }

    for (const w of app.workers) {
      rows.push(formatWorkerRow(app.name, w));
    }
  }

  console.log(formatTable(headers, rows));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWorkerRow(appName: string, w: WorkerInfo): string[] {
  const now = Date.now();
  const uptime = w.startedAt ? now - w.startedAt : 0;
  const cpu = w.cpu ? `${w.cpu.percentage.toFixed(1)}%` : '\u2014';
  const mem = w.memory ? formatMemory(w.memory.rss) : '\u2014';

  return [
    appName,
    formatState(w.state),
    w.pid ? String(w.pid) : '\u2014',
    cpu,
    mem,
    formatUptime(uptime),
    String(w.restartCount),
  ];
}
