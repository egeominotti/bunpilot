import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES_PER_FILE = 4 * 1024 * 1024;

interface LogFile {
  absolutePath: string;
  relativePath: string;
}

/** Extract the numeric rotation index; the current file sorts as newest. */
export function rotationIndex(filename: string): number {
  const match = filename.match(/\.(\d+)\.log$/);
  return match ? Number.parseInt(match[1], 10) : -1;
}

/** Sort one log stream from its oldest rotation to its current file. */
export function compareRotatedLogs(a: string, b: string): number {
  const baseA = a.replace(/(\.\d+)?\.log$/, '');
  const baseB = b.replace(/(\.\d+)?\.log$/, '');
  if (baseA !== baseB) return baseA.localeCompare(baseB);
  return rotationIndex(b) - rotationIndex(a);
}

/** Strip the rotation suffix so every rotation of one stream shares a key. */
function streamBase(relativePath: string): string {
  return relativePath.replace(/(\.\d+)?\.log$/, '');
}

/**
 * Return the most recent non-empty log lines without allowing an app name to
 * escape its log directory. Reads only a bounded tail from each file.
 *
 * An app has several independent streams (`app-0-out`, `app-0-err`, one pair per
 * worker). They live in separate files, so a single chatty stream must never be
 * allowed to drain the whole tail budget and hide another stream entirely —
 * crucially the stderr file carrying a crash reason. The budget is therefore
 * shared round-robin across streams: every non-empty stream is represented when
 * `maxLines` is at least the stream count, and any leftover budget goes to the
 * chattier streams. Each stream keeps its own lines contiguous and oldest-first,
 * and streams are emitted in a stable order (by base name) so that a follower
 * comparing successive snapshots only ever sees lines inserted, never reordered.
 */
export function readLogLines(logsDir: string, appName: string, maxLines: number): string[] {
  if (!isSafeAppName(appName) || !Number.isSafeInteger(maxLines) || maxLines < 1) return [];

  const appDir = join(logsDir, appName);
  if (!existsSync(appDir)) return [];

  // `compareRotatedLogs` groups each stream's files together (equal base) and
  // orders them oldest -> newest, so a single forward pass builds the streams.
  const files = collectLogFiles(appDir).sort((a, b) =>
    compareRotatedLogs(a.relativePath, b.relativePath),
  );

  const streams: { base: string; files: LogFile[] }[] = [];
  let currentBase: string | null = null;
  for (const file of files) {
    const base = streamBase(file.relativePath);
    if (base !== currentBase) {
      streams.push({ base, files: [] });
      currentBase = base;
    }
    streams[streams.length - 1].files.push(file);
  }

  // Read each stream's own bounded tail, then keep only the non-empty ones.
  const perStream = streams
    .map((group) => ({ base: group.base, lines: tailStream(group.files, maxLines) }))
    .filter((stream) => stream.lines.length > 0);

  const counts = allocateBudget(
    perStream.map((stream) => stream.lines.length),
    maxLines,
    // stderr streams win the round-robin: when the caller asks for fewer lines
    // than there are streams, a fresh crash reason on `-err` must not be hidden
    // by a chatty stdout stream (h-reader scarce-budget case).
    perStream.map((stream) => isStderrStream(stream.base)),
  );

  // Emit in stable base-name order so a follower comparing snapshots only ever
  // sees lines inserted, never reordered — independent of budget priority.
  const result: string[] = [];
  for (let i = 0; i < perStream.length; i++) {
    const lines = perStream[i].lines;
    result.push(...lines.slice(lines.length - counts[i]));
  }

  return result;
}

/** A worker's stderr stream, named `<app>-<id>-err[.N].log`. */
function isStderrStream(base: string): boolean {
  return base.endsWith('-err');
}

/** Read the combined tail of one stream's rotations, newest lines last. */
function tailStream(files: LogFile[], maxLines: number): string[] {
  const lines: string[] = [];
  // Files are ordered oldest -> newest; walk from the newest until the budget
  // for this stream is met.
  for (let index = files.length - 1; index >= 0 && lines.length < maxLines; index--) {
    const remaining = maxLines - lines.length;
    lines.unshift(...tailFile(files[index].absolutePath, remaining));
  }
  return lines.slice(-maxLines);
}

/**
 * Share `budget` across streams round-robin: one line to each stream per pass
 * (skipping any that have already yielded all their lines) until the budget is
 * spent. Guarantees each non-empty stream gets at least one line whenever
 * `budget >= streams`, while surplus budget flows to the chattier streams.
 *
 * `priority` biases the per-pass visit order (priority streams first) so that
 * when `budget < streams` the lines go to the important streams — the stderr
 * files carrying crash reasons — instead of the fixed leading streams. The
 * returned counts stay indexed to `sizes`; only which streams win a scarce
 * budget changes, never the caller's emission order.
 */
function allocateBudget(sizes: number[], budget: number, priority?: boolean[]): number[] {
  const counts = sizes.map(() => 0);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  let remaining = Math.min(budget, total);

  // Visit priority streams first each pass; ties keep the original index order.
  const order = sizes
    .map((_, i) => i)
    .sort((a, b) => Number(priority?.[b] ?? false) - Number(priority?.[a] ?? false) || a - b);

  let progressed = true;
  while (remaining > 0 && progressed) {
    progressed = false;
    for (const i of order) {
      if (remaining <= 0) break;
      if (counts[i] < sizes[i]) {
        counts[i]++;
        remaining--;
        progressed = true;
      }
    }
  }
  return counts;
}

function isSafeAppName(appName: string): boolean {
  return (
    appName.length > 0 &&
    appName !== '.' &&
    appName !== '..' &&
    !appName.includes('/') &&
    !appName.includes('\\') &&
    !appName.includes('\0')
  );
}

function collectLogFiles(directory: string, relativeDirectory: string = ''): LogFile[] {
  const files: LogFile[] = [];
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory ? join(relativeDirectory, entry.name) : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectLogFiles(absolutePath, relativePath));
      } else if (entry.isFile() && entry.name.endsWith('.log')) {
        files.push({ absolutePath, relativePath });
      }
    }
  } catch {
    // A file or directory can disappear while rotation is in progress.
  }
  return files;
}

function tailFile(filePath: string, maxLines: number): string[] {
  let descriptor: number | null = null;
  try {
    descriptor = openSync(filePath, 'r');
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, MAX_BYTES_PER_FILE);
    const start = size - length;
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = readSync(descriptor, buffer, 0, length, start);
    let text = new TextDecoder().decode(buffer.subarray(0, bytesRead));

    // The bounded window may begin in the middle of a line (or UTF-8 codepoint).
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1);
    }

    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
