// ---------------------------------------------------------------------------
// bunpilot – CLI Command: metrics
// ---------------------------------------------------------------------------
//
// Retrieve and display application metrics. Supports plain-text, JSON,
// Prometheus exposition format, and a deep runtime-telemetry report
// (heap composition, GC pressure, event-loop / stack health).
// ---------------------------------------------------------------------------

import type { AppStatus, WorkerInfo, WorkerTelemetry } from '../../config/types';
import { formatMemory, formatTable, logWarn } from '../format';
import { sendCommand } from './_connect';

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

  // ---- Deep runtime telemetry report ----
  if (flags.deep) {
    printDeep(apps);
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
  const cpu = w.cpu ? `${w.cpu.percentage.toFixed(1)}` : '—';
  const rss = w.memory ? formatMemory(w.memory.rss) : '—';
  const heapUsed = w.memory ? formatMemory(w.memory.heapUsed) : '—';
  const heapTotal = w.memory ? formatMemory(w.memory.heapTotal) : '—';

  return [appName, String(w.id), w.pid ? String(w.pid) : '—', cpu, rss, heapUsed, heapTotal];
}

function printPrometheus(apps: AppStatus[]): void {
  const lines: string[] = [];

  for (const app of apps) {
    const labels = (w: WorkerInfo) =>
      `{app="${escapeLabelValue(app.name)}",worker="${w.slot ?? w.id}",pid="${w.pid}"}`;

    for (const w of app.workers) {
      if (w.cpu) {
        lines.push(`bunpilot_cpu_percent${labels(w)} ${w.cpu.percentage.toFixed(2)}`);
      }
      if (w.memory) {
        lines.push(`bunpilot_memory_rss_bytes${labels(w)} ${w.memory.rss}`);
        lines.push(`bunpilot_memory_heap_used_bytes${labels(w)} ${w.memory.heapUsed}`);
        lines.push(`bunpilot_memory_heap_total_bytes${labels(w)} ${w.memory.heapTotal}`);
        lines.push(`bunpilot_memory_external_bytes${labels(w)} ${w.memory.external}`);
      }
      lines.push(`bunpilot_restart_count${labels(w)} ${w.restartCount}`);

      const t = w.telemetry;
      if (t) {
        lines.push(`bunpilot_heap_size_bytes${labels(w)} ${t.heap.heapSize}`);
        if (t.heap.v8StatisticsAvailable !== false) {
          lines.push(`bunpilot_heap_limit_bytes${labels(w)} ${t.heap.heapSizeLimit}`);
        }
        if (t.heap.censusAvailable !== false) {
          lines.push(`bunpilot_heap_object_count${labels(w)} ${t.heap.objectCount}`);
        }
        lines.push(`bunpilot_heap_array_buffers_bytes${labels(w)} ${t.heap.arrayBuffers}`);
        lines.push(`bunpilot_gc_heap_utilization${labels(w)} ${t.gc.heapUtilization.toFixed(4)}`);
        lines.push(
          `bunpilot_gc_allocation_rate_bytes${labels(w)} ${Math.round(t.gc.allocationRateBytesPerSec)}`,
        );
        lines.push(`bunpilot_gc_collections_total${labels(w)} ${t.gc.inferredCollections}`);
        lines.push(`bunpilot_event_loop_lag_ms${labels(w)} ${t.stack.eventLoopLagMs.toFixed(3)}`);
        lines.push(
          `bunpilot_event_loop_utilization${labels(w)} ${t.stack.eventLoopUtilization.toFixed(4)}`,
        );
        lines.push(`bunpilot_active_resources${labels(w)} ${t.stack.activeResources}`);
      }
    }
  }

  console.log(lines.join('\n'));
}

/** Human-readable deep telemetry report. */
function printDeep(apps: AppStatus[]): void {
  if (apps.length === 0) {
    logWarn('No metrics available');
    return;
  }

  let printedAny = false;
  const out: string[] = [];

  for (const app of apps) {
    for (const w of app.workers) {
      const t = w.telemetry;
      if (!t) continue;
      printedAny = true;
      out.push(`\n${app.name} · worker ${w.id}${w.pid ? ` (pid ${w.pid})` : ''} · ${w.state}`);
      out.push(...heapSection(t));
      out.push(...gcSection(t));
      out.push(...stackSection(t));
    }
  }

  if (!printedAny) {
    logWarn('No deep telemetry reported yet (workers must call bunpilotStartMetrics())');
    return;
  }
  console.log(out.join('\n'));
}

function heapSection(t: WorkerTelemetry): string[] {
  const h = t.heap;
  const lines = [
    '  heap:',
    `    live/capacity ${formatMemory(h.heapSize)} / ${formatMemory(h.heapCapacity)} (${(t.gc.heapUtilization * 100).toFixed(1)}%)`,
    `    capacity      ${formatMemory(h.heapCapacity)}`,
    `    arrayBuffers  ${formatMemory(h.arrayBuffers)}`,
  ];
  if (h.v8StatisticsAvailable !== false) {
    lines.push(`    hard limit    ${formatMemory(h.heapSizeLimit)}`);
    lines.push(`    contexts      ${h.nativeContexts} native, ${h.detachedContexts} detached`);
  }
  if (h.censusAvailable !== false) {
    lines.push(`    objects       ${h.objectCount.toLocaleString()}`);
  }
  if (h.censusAvailable !== false && h.topObjectTypes.length > 0) {
    lines.push('    top object types:');
    for (const { type, count } of h.topObjectTypes.slice(0, 8)) {
      lines.push(`      ${type.padEnd(22)} ${count.toLocaleString()}`);
    }
  }
  return lines;
}

function gcSection(t: WorkerTelemetry): string[] {
  const g = t.gc;
  return [
    '  gc (derived):',
    `    heap growth   ${formatSignedBytes(g.heapGrowthBytes)}`,
    `    alloc rate    ${formatMemory(g.allocationRateBytesPerSec)}/s`,
    `    reclaimed     ${formatMemory(g.reclaimedBytes)}`,
    `    collections   ${g.inferredCollections} (inferred)`,
    `    jit compile   ${g.compileTimeMs.toFixed(1)} ms`,
  ];
}

function stackSection(t: WorkerTelemetry): string[] {
  const s = t.stack;
  return [
    '  stack / event loop:',
    `    lag mean/max/p99  ${s.eventLoopLagMs.toFixed(2)} / ${s.eventLoopLagMaxMs.toFixed(2)} / ${s.eventLoopLagP99Ms.toFixed(2)} ms`,
    `    utilization       ${(s.eventLoopUtilization * 100).toFixed(1)}%`,
    `    active resources  ${s.activeResources}`,
    `    sampler depth     ${s.callStackDepth}`,
  ];
}

function formatSignedBytes(bytes: number): string {
  const sign = bytes < 0 ? '-' : '+';
  return `${sign}${formatMemory(Math.abs(bytes))}`;
}

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
