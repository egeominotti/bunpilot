// ---------------------------------------------------------------------------
// bunpm – Log File Writer with Rotation
// ---------------------------------------------------------------------------

import { unlinkSync, renameSync, existsSync, appendFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// LogWriter
// ---------------------------------------------------------------------------

export class LogWriter {
  private readonly filePath: string;
  private readonly maxSize: number;
  private readonly maxFiles: number;
  private currentSize: number = 0;
  private closed: boolean = false;

  constructor(filePath: string, maxSize: number, maxFiles: number) {
    this.filePath = filePath;
    this.maxSize = maxSize;
    this.maxFiles = maxFiles;
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

    if (await this.checkSize()) {
      await this.rotate();
    }

    const encoded = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    appendFileSync(this.filePath, encoded);
    this.currentSize += encoded.byteLength;
  }

  /**
   * Rotate log files: current -> .1, .1 -> .2, etc.
   * Deletes the oldest file when `maxFiles` is exceeded.
   */
  async rotate(): Promise<void> {
    // Delete the oldest rotated file if it exists
    const oldestPath = `${this.filePath}.${this.maxFiles}`;
    if (existsSync(oldestPath)) {
      unlinkSync(oldestPath);
    }

    // Shift rotated files: .N-1 -> .N, .N-2 -> .N-1, ...
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      if (existsSync(src)) {
        renameSync(src, dst);
      }
    }

    // Rotate current file to .1
    const currentFile = Bun.file(this.filePath);
    if (await currentFile.exists()) {
      renameSync(this.filePath, `${this.filePath}.1`);
    }

    this.currentSize = 0;
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
  private async checkSize(): Promise<boolean> {
    return this.currentSize >= this.maxSize;
  }
}
