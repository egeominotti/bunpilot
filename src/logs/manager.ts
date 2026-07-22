// ---------------------------------------------------------------------------
// bunpm – Log Manager: orchestrates writers and stream piping
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { LogsConfig } from '../config/types';
import { LOGS_DIR } from '../constants';
import { LogWriter } from './writer';

// ---------------------------------------------------------------------------
// LogManager
// ---------------------------------------------------------------------------

export class LogManager {
  private static readonly PIPE_DRAIN_TIMEOUT_MS = 5_000;
  private readonly baseDir: string;
  private readonly writers: Map<string, LogWriter> = new Map();
  private readonly activePipes = new Map<string, Set<Promise<void>>>();

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
      mkdirSync(appDir, { recursive: true, mode: 0o700 });
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

    mkdirSync(dirname(stdoutPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(stderrPath), { recursive: true, mode: 0o700 });
    const stdoutWriter = new LogWriter(stdoutPath, config.maxSize, config.maxFiles);
    const stderrWriter =
      stderrPath === stdoutPath
        ? stdoutWriter
        : new LogWriter(stderrPath, config.maxSize, config.maxFiles);

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

    this.trackPipe(
      `${appName}:${workerId}:stdout`,
      this.pipeStream(stdout, outWriter, foreground ? process.stdout : null, prefix),
    );
    this.trackPipe(
      `${appName}:${workerId}:stderr`,
      this.pipeStream(stderr, errWriter, foreground ? process.stderr : null, prefix),
    );
  }

  /** Drain active streams, bounded by a timeout, then close every writer. */
  async closeAll(): Promise<void> {
    const pending = this.drainPipes(() => true);
    if (pending) await pending;
    for (const writer of this.writers.values()) {
      writer.close();
    }
    this.writers.clear();
  }

  /** Close and forget both streams for a single worker generation. */
  closeWorker(appName: string, workerId: number): Promise<void> {
    const close = () => {
      for (const stream of ['stdout', 'stderr'] as const) {
        const key = `${appName}:${workerId}:${stream}`;
        this.writers.get(key)?.close();
        this.writers.delete(key);
      }
    };
    const pending = this.drainPipes((key) => key.startsWith(`${appName}:${workerId}:`));
    if (pending) return pending.then(close);
    close();
    return Promise.resolve();
  }

  /** Close and forget every writer owned by one application. */
  closeApp(appName: string): Promise<void> {
    const prefix = `${appName}:`;
    const pending = this.drainPipes((key) => key.startsWith(prefix));
    const close = () => {
      for (const [key, writer] of this.writers) {
        if (key.startsWith(prefix)) {
          writer.close();
          this.writers.delete(key);
        }
      }
    };
    if (pending) return pending.then(close);
    close();
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private trackPipe(key: string, task: Promise<void>): void {
    let tasks = this.activePipes.get(key);
    if (!tasks) {
      tasks = new Set();
      this.activePipes.set(key, tasks);
    }
    tasks.add(task);
    void task.finally(() => {
      tasks?.delete(task);
      if (tasks?.size === 0 && this.activePipes.get(key) === tasks) {
        this.activePipes.delete(key);
      }
    });
  }

  private drainPipes(predicate: (key: string) => boolean): Promise<void> | undefined {
    const pending = [...this.activePipes.entries()]
      .filter(([key]) => predicate(key))
      .flatMap(([, tasks]) => [...tasks]);
    if (pending.length === 0) return undefined;
    return Promise.race([
      Promise.allSettled(pending),
      new Promise<void>((resolve) => setTimeout(resolve, LogManager.PIPE_DRAIN_TIMEOUT_MS)),
    ]).then(() => undefined);
  }

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
    const reader = stream.getReader();
    let pendingConsoleLine = '';

    // A normal end-of-stream surfaces as `{ done: true }` — never an error — so
    // any thrown error here is unexpected (broken pipe, disk full, …) and is
    // surfaced rather than classified by fragile error-message substrings.
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        await writer.write(value);

        if (console) {
          pendingConsoleLine += decoder.decode(value, { stream: true });
          const lines = pendingConsoleLine.split('\n');
          pendingConsoleLine = lines.pop() ?? '';
          for (const line of lines) {
            console.write(`${prefix} ${line}\n`);
          }
        }
      }
      if (console) {
        pendingConsoleLine += decoder.decode();
        if (pendingConsoleLine.length > 0) console.write(`${prefix} ${pendingConsoleLine}\n`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${prefix} log pipe error: ${msg}\n`);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* reader may already be released */
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
    const directory = dirname(filename);
    const suffixed = `${base}-${workerId}${ext}`;
    return directory === '.' ? suffixed : join(directory, suffixed);
  }
}
