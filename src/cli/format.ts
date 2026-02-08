// ---------------------------------------------------------------------------
// bunpilot – Output Formatting Utilities
// ---------------------------------------------------------------------------

import type { WorkerState } from '../config/types';

// ---------------------------------------------------------------------------
// ANSI Colors
// ---------------------------------------------------------------------------

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// Table Formatting
// ---------------------------------------------------------------------------

/**
 * Format headers and rows into an aligned ASCII table.
 *
 * Example output:
 *   NAME       │ STATUS  │ PID
 *   my-app     │ online  │ 1234
 *   worker-2   │ stopped │ —
 */
export function formatTable(headers: string[], rows: string[][]): string {
  if (headers.length === 0) return '';

  // Calculate the maximum width for each column
  const colWidths = headers.map((h, i) => {
    const dataMax = rows.reduce((max, row) => {
      const cell = row[i] ?? '';
      return Math.max(max, stripAnsi(cell).length);
    }, 0);
    return Math.max(stripAnsi(h).length, dataMax);
  });

  const separator = ' \u2502 '; // │

  // Build header line
  const headerLine = headers.map((h, i) => padRight(h, colWidths[i])).join(separator);

  // Build data lines
  const dataLines = rows.map((row) =>
    row.map((cell, i) => padRight(cell, colWidths[i])).join(separator),
  );

  return [headerLine, ...dataLines].join('\n');
}

// ---------------------------------------------------------------------------
// Uptime Formatting
// ---------------------------------------------------------------------------

/**
 * Convert milliseconds to human-readable duration.
 *
 * Examples: "45s", "2h 15m", "3d 2h"
 */
export function formatUptime(ms: number): string {
  if (ms < 0) return '0s';

  const seconds = Math.floor(ms / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------
// Memory Formatting
// ---------------------------------------------------------------------------

/**
 * Convert bytes to human-readable size.
 *
 * Examples: "45.2 MB", "1.2 GB", "512 KB"
 */
export function formatMemory(bytes: number): string {
  if (bytes < 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIdx = 0;

  while (value >= 1024 && unitIdx < units.length - 1) {
    value /= 1024;
    unitIdx++;
  }

  const formatted = unitIdx === 0 ? `${value}` : `${value.toFixed(1)}`;

  return `${formatted} ${units[unitIdx]}`;
}

// ---------------------------------------------------------------------------
// State Formatting
// ---------------------------------------------------------------------------

/**
 * Format a worker state with terminal color codes.
 *
 *   online             -> green
 *   crashed / errored  -> red
 *   everything else    -> yellow
 */
export function formatState(state: WorkerState): string {
  switch (state) {
    case 'online':
      return `${GREEN}${state}${RESET}`;
    case 'crashed':
    case 'errored':
      return `${RED}${state}${RESET}`;
    default:
      return `${YELLOW}${state}${RESET}`;
  }
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const PREFIX = `${BOLD}[bunpilot]${RESET}`;

/**
 * Formatted log output: `[bunpilot] prefix | message`
 */
export function log(prefix: string, message: string): void {
  console.log(`${PREFIX} ${GREEN}${prefix}${RESET} \u2502 ${message}`);
}

/**
 * Formatted error output: `[bunpilot] ERROR | message`
 */
export function logError(message: string): void {
  console.error(`${PREFIX} ${RED}ERROR${RESET} \u2502 ${message}`);
}

/**
 * Formatted success output.
 */
export function logSuccess(message: string): void {
  console.log(`${PREFIX} ${GREEN}OK${RESET} \u2502 ${message}`);
}

/**
 * Formatted warning output.
 */
export function logWarn(message: string): void {
  console.log(`${PREFIX} ${YELLOW}WARN${RESET} \u2502 ${message}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ANSI escape sequences for width calculation. */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Pad a string to the right, accounting for invisible ANSI codes.
 * The visible width is used for alignment, so colored strings align correctly.
 */
function padRight(str: string, width: number): string {
  const visibleLength = stripAnsi(str).length;
  const padding = Math.max(0, width - visibleLength);
  return str + ' '.repeat(padding);
}
