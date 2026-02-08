// ---------------------------------------------------------------------------
// bunpm2 – CLI Command: status
// ---------------------------------------------------------------------------
//
// Show detailed status for a single application including its configuration
// and a per-worker breakdown.
// ---------------------------------------------------------------------------

import { sendCommand, requireArg } from './_connect';
import { formatTable, formatUptime, formatMemory, formatState, log } from '../format';
import type { AppStatus, WorkerInfo } from '../../config/types';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function statusCommand(
  args: string[],
  _flags: Record<string, string | boolean>,
): Promise<void> {
  const name = requireArg(args, 'app-name');
  const res = await sendCommand('status', { name }, { silent: true });
  const app = res.data as AppStatus;

  // ---- App-level info ----
  console.log('');
  log('app', app.name);
  log('status', formatState(app.status === 'running' ? 'online' : 'stopped'));
  log('script', app.config.script);
  log('instances', String(app.config.instances));

  if (app.config.port) {
    log('port', String(app.config.port));
  }

  if (app.startedAt) {
    log('uptime', formatUptime(Date.now() - app.startedAt));
  }

  if (app.config.cwd) {
    log('cwd', app.config.cwd);
  }

  // ---- Worker table ----
  console.log('');

  if (app.workers.length === 0) {
    console.log('  No workers');
    return;
  }

  const headers = ['ID', 'PID', 'STATE', 'CPU', 'MEM', 'UPTIME', 'RESTARTS'];
  const rows = app.workers.map((w) => formatWorkerRow(w));

  console.log(formatTable(headers, rows));
  console.log('');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatWorkerRow(w: WorkerInfo): string[] {
  const now = Date.now();
  const uptime = w.startedAt ? now - w.startedAt : 0;
  const cpu = w.cpu ? `${w.cpu.percentage.toFixed(1)}%` : '\u2014';
  const mem = w.memory ? formatMemory(w.memory.rss) : '\u2014';

  return [
    String(w.id),
    w.pid ? String(w.pid) : '\u2014',
    formatState(w.state),
    cpu,
    mem,
    formatUptime(uptime),
    String(w.restartCount),
  ];
}
