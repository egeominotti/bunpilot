// ---------------------------------------------------------------------------
// bunpm2 – CLI Command: metrics
// ---------------------------------------------------------------------------
//
// Retrieve and display application metrics. Supports plain-text, JSON,
// and Prometheus exposition format output.
// ---------------------------------------------------------------------------

import { sendCommand } from './_connect';
import { formatTable, formatMemory, logWarn } from '../format';
import type { AppStatus, WorkerInfo } from '../../config/types';

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function metricsCommand(
  args: string[],
  flags: Record<string, string | boolean>,
): Promise<void> {
  const name = args[0] ?? undefined;
  const res = await sendCommand('metrics', name ? { name } : undefined, { silent: true });
  const apps = (res.data ?? []) as AppStatus[];

  // ---- JSON output ----
  if (flags.json) {
    console.log(JSON.stringify(apps, null, 2));
    return;
  }

  // ---- Prometheus exposition format ----
  if (flags.prometheus) {
    printPrometheus(apps);
    return;
  }

  // ---- Table output ----
  if (apps.length === 0) {
    logWarn('No metrics available');
    return;
  }

  const headers = ['APP', 'WORKER', 'PID', 'CPU %', 'RSS', 'HEAP USED', 'HEAP TOTAL'];
  const rows: string[][] = [];

  for (const app of apps) {
    for (const w of app.workers) {
      rows.push(formatMetricsRow(app.name, w));
    }
  }

  console.log(formatTable(headers, rows));
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatMetricsRow(appName: string, w: WorkerInfo): string[] {
  const cpu = w.cpu ? `${w.cpu.percentage.toFixed(1)}` : '\u2014';
  const rss = w.memory ? formatMemory(w.memory.rss) : '\u2014';
  const heapUsed = w.memory ? formatMemory(w.memory.heapUsed) : '\u2014';
  const heapTotal = w.memory ? formatMemory(w.memory.heapTotal) : '\u2014';

  return [appName, String(w.id), w.pid ? String(w.pid) : '\u2014', cpu, rss, heapUsed, heapTotal];
}

function printPrometheus(apps: AppStatus[]): void {
  const lines: string[] = [];

  for (const app of apps) {
    const labels = (w: WorkerInfo) => `{app="${app.name}",worker="${w.id}",pid="${w.pid}"}`;

    for (const w of app.workers) {
      if (w.cpu) {
        lines.push(`bunpm2_cpu_percent${labels(w)} ${w.cpu.percentage.toFixed(2)}`);
      }
      if (w.memory) {
        lines.push(`bunpm2_memory_rss_bytes${labels(w)} ${w.memory.rss}`);
        lines.push(`bunpm2_memory_heap_used_bytes${labels(w)} ${w.memory.heapUsed}`);
        lines.push(`bunpm2_memory_heap_total_bytes${labels(w)} ${w.memory.heapTotal}`);
        lines.push(`bunpm2_memory_external_bytes${labels(w)} ${w.memory.external}`);
      }
      lines.push(`bunpm2_restart_count${labels(w)} ${w.restartCount}`);
    }
  }

  console.log(lines.join('\n'));
}
