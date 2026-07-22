// ---------------------------------------------------------------------------
// bunpm – Log File Writer with Rotation
// ---------------------------------------------------------------------------

import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, extname } from 'node:path';

/** Build `app.1.log` from `app.log`, preserving any parent directory. */
export function rotatedLogPath(filePath: string, index: number): string {
  const extension = extname(filePath);
  if (!extension) return `${filePath}.${index}`;
  return `${filePath.slice(0, -extension.length)}.${index}${extension}`;
}

// ---------------------------------------------------------------------------
// LogWriter
// ---------------------------------------------------------------------------

export class LogWriter {
  private readonly filePath: string;
  private readonly maxSize: number;
  private readonly maxFiles: number;
  private currentSize: number = 0;
  private closed: boolean = false;
  private rotating: boolean = false;

  constructor(filePath: string, maxSize: number, maxFiles: number) {
    if (!Number.isSafeInteger(maxSize) || maxSize <= 0) throw new Error('maxSize must be positive');
    if (!Number.isSafeInteger(maxFiles) || maxFiles <= 0)
      throw new Error('maxFiles must be positive');
    this.filePath = filePath;
    this.maxSize = maxSize;
    this.maxFiles = maxFiles;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    if (existsSync(filePath)) chmodSync(filePath, 0o600);
    this.initSize();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Append data to the current log file.
   * Triggers rotation when the file exceeds `maxSize`.
   */
  async write(data: Uint8Array | string): Promise<void> {
    if (this.closed) return;

    if (this.checkSize()) {
      await this.rotate();
    }

    const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    appendFileSync(this.filePath, encoded, { mode: 0o600 });
    chmodSync(this.filePath, 0o600);
    this.currentSize += encoded.byteLength;

    // Check again after write — a single large chunk may have pushed past maxSize
    if (this.checkSize()) {
      await this.rotate();
    }
  }

  /**
   * Rotate log files: current -> .1, .1 -> .2, etc.
   * Deletes the oldest file when `maxFiles` is exceeded.
   */
  async rotate(): Promise<void> {
    // Guard against concurrent rotation
    if (this.rotating) return;
    this.rotating = true;

    try {
      // Delete the oldest rotated file if it exists
      const oldestPath = rotatedLogPath(this.filePath, this.maxFiles);
      if (existsSync(oldestPath)) {
        unlinkSync(oldestPath);
      }

      // Shift rotated files: .N-1 -> .N, .N-2 -> .N-1, ...
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const src = rotatedLogPath(this.filePath, i);
        const dst = rotatedLogPath(this.filePath, i + 1);
        if (existsSync(src)) {
          renameSync(src, dst);
        }
      }

      // Rotate current file to .1
      if (existsSync(this.filePath)) {
        renameSync(this.filePath, rotatedLogPath(this.filePath, 1));
      }

      this.currentSize = 0;
    } finally {
      this.rotating = false;
    }
  }

  /** Flush and cleanup. */
  close(): void {
    this.closed = true;
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /** Sync-initialize the in-memory size tracker from the file on disk. */
  private initSize(): void {
    const file = Bun.file(this.filePath);
    // Bun.file().size returns 0 for non-existent files; we guard with existsSync
    if (existsSync(this.filePath)) {
      this.currentSize = file.size;
    }
  }

  /** Returns true when the current file needs rotation. */
  private checkSize(): boolean {
    return this.currentSize >= this.maxSize;
  }
}
