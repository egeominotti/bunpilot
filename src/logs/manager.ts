// ---------------------------------------------------------------------------
// bunpm – Log Manager: orchestrates writers and stream piping
// ---------------------------------------------------------------------------

import { mkdirSync, existsSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { LOGS_DIR } from '../constants';
import type { LogsConfig } from '../config/types';
import { LogWriter } from './writer';

// ---------------------------------------------------------------------------
// LogManager
// ---------------------------------------------------------------------------

export class LogManager {
  private readonly baseDir: string;
  private readonly writers: Map<string, LogWriter> = new Map();

  constructor(baseDir: string = LOGS_DIR) {
    this.baseDir = baseDir;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Create stdout and stderr writers for a given app worker.
   * Ensures the log directory exists before returning.
   */
  createWriters(
    appName: string,
    workerId: number,
    config: LogsConfig,
  ): { stdout: LogWriter; stderr: LogWriter } {
    const appDir = join(this.baseDir, appName);
    if (!existsSync(appDir)) {
      mkdirSync(appDir, { recursive: true });
    }

    // Bug 5: Close existing writers for the same key before creating new ones
    const stdoutKey = `${appName}:${workerId}:stdout`;
    const stderrKey = `${appName}:${workerId}:stderr`;

    const existingOut = this.writers.get(stdoutKey);
    if (existingOut) existingOut.close();

    const existingErr = this.writers.get(stderrKey);
    if (existingErr) existingErr.close();

    // Bug 7: When custom filenames are used with workerId > 0,
    // append workerId to avoid collisions
    const outFile = config.outFile
      ? this.addWorkerSuffix(config.outFile, workerId)
      : `${appName}-${workerId}-out.log`;
    const errFile = config.errFile
      ? this.addWorkerSuffix(config.errFile, workerId)
      : `${appName}-${workerId}-err.log`;

    const stdoutPath = join(appDir, outFile);
    const stderrPath = join(appDir, errFile);

    const stdoutWriter = new LogWriter(stdoutPath, config.maxSize, config.maxFiles);
    const stderrWriter = new LogWriter(stderrPath, config.maxSize, config.maxFiles);

    // Track writers for cleanup
    this.writers.set(stdoutKey, stdoutWriter);
    this.writers.set(stderrKey, stderrWriter);

    return { stdout: stdoutWriter, stderr: stderrWriter };
  }

  /**
   * Pipe readable streams to log files.
   * In foreground mode, output is also written to process.stdout / stderr
   * with a `[appName:workerId]` prefix on each line.
   */
  pipeOutput(
    appName: string,
    workerId: number,
    stdout: ReadableStream,
    stderr: ReadableStream,
    config: LogsConfig,
    foreground: boolean,
  ): void {
    const { stdout: outWriter, stderr: errWriter } = this.createWriters(appName, workerId, config);

    const prefix = `[${appName}:${workerId}]`;

    this.pipeStream(stdout, outWriter, foreground ? process.stdout : null, prefix);
    this.pipeStream(stderr, errWriter, foreground ? process.stderr : null, prefix);
  }

  /** Close every active writer and clear the internal map. */
  closeAll(): void {
    for (const writer of this.writers.values()) {
      writer.close();
    }
    this.writers.clear();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  /**
   * Consume a ReadableStream, writing each chunk to the LogWriter
   * and optionally echoing to a NodeJS.WriteStream (console).
   */
  private async pipeStream(
    stream: ReadableStream,
    writer: LogWriter,
    console: NodeJS.WriteStream | null,
    prefix: string,
  ): Promise<void> {
    const decoder = new TextDecoder();

    try {
      const reader = stream.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        await writer.write(value);

        if (console) {
          const text = decoder.decode(value, { stream: true });
          const lines = text.split('\n');
          for (const line of lines) {
            if (line.length > 0) {
              console.write(`${prefix} ${line}\n`);
            }
          }
        }
      }
    } catch (err: unknown) {
      // Differentiate between expected stream-close errors and real failures
      const msg = err instanceof Error ? err.message : String(err);
      const isStreamClose =
        msg.includes('ReadableStream') ||
        msg.includes('stream') ||
        msg.includes('cancel') ||
        msg.includes('reader');

      if (!isStreamClose) {
        process.stderr.write(`${prefix} log pipe error: ${msg}\n`);
      }
    }
  }

  /**
   * For custom filenames with workerId > 0, insert the workerId before
   * the extension to avoid collisions: "app.log" -> "app-1.log"
   */
  private addWorkerSuffix(filename: string, workerId: number): string {
    if (workerId === 0) return filename;
    const ext = extname(filename);
    const base = basename(filename, ext);
    return `${base}-${workerId}${ext}`;
  }
}
