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

/**
 * Return the most recent non-empty log lines without allowing an app name to
 * escape its log directory. Reads only a bounded tail from each file.
 */
export function readLogLines(logsDir: string, appName: string, maxLines: number): string[] {
  if (!isSafeAppName(appName) || !Number.isSafeInteger(maxLines) || maxLines < 1) return [];

  const appDir = join(logsDir, appName);
  if (!existsSync(appDir)) return [];

  const files = collectLogFiles(appDir).sort((a, b) =>
    compareRotatedLogs(a.relativePath, b.relativePath),
  );
  const result: string[] = [];

  // Walk newest to oldest and stop once the requested tail is complete.
  for (let index = files.length - 1; index >= 0 && result.length < maxLines; index--) {
    const remaining = maxLines - result.length;
    const lines = tailFile(files[index].absolutePath, remaining);
    result.unshift(...lines);
  }

  return result.slice(-maxLines);
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
