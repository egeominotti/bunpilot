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

/**
 * A single in-flight stream->log pipe: the promise that settles when the read
 * loop exits, plus a `cancel` that aborts the underlying reader so a stalled
 * stream (write end still held by an orphaned grandchild) can be released
 * instead of leaking forever in `activePipes`.
 */
interface PipeHandle {
  readonly promise: Promise<void>;
  readonly cancel: () => Promise<void>;
}

export class LogManager {
  private static readonly PIPE_DRAIN_TIMEOUT_MS = 5_000;
  private readonly baseDir: string;
  private readonly writers: Map<string, LogWriter> = new Map();
  private readonly activePipes = new Map<string, Set<PipeHandle>>();

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
      this.startPipe(stdout, outWriter, foreground ? process.stdout : null, prefix),
    );
    this.trackPipe(
      `${appName}:${workerId}:stderr`,
      this.startPipe(stderr, errWriter, foreground ? process.stderr : null, prefix),
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

  private trackPipe(key: string, handle: PipeHandle): void {
    let tasks = this.activePipes.get(key);
    if (!tasks) {
      tasks = new Set();
      this.activePipes.set(key, tasks);
    }
    tasks.add(handle);
    void handle.promise.finally(() => {
      tasks?.delete(handle);
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
    return this.drainHandles(pending);
  }

  /**
   * Give the pipes a bounded window to finish on their own; if any are still
   * running when it closes they are stalled (e.g. a grandchild still holds the
   * pipe's write end), so cancel their readers. Cancelling makes each read loop
   * observe `{ done: true }`, settle its promise, and drop out of `activePipes`
   * via `trackPipe`'s `finally` — so a later close never re-pays the timeout for
   * an already-gone worker.
   */
  private async drainHandles(handles: PipeHandle[]): Promise<void> {
    const settled = Promise.allSettled(handles.map((handle) => handle.promise));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = await Promise.race([
      settled.then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), LogManager.PIPE_DRAIN_TIMEOUT_MS);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (timedOut) {
      await Promise.allSettled(handles.map((handle) => handle.cancel()));
      await settled;
    }
  }

  /**
   * Start consuming a stream into its LogWriter. Returns the read-loop promise
   * plus a `cancel` bound to the stream's reader, so a stalled pipe can be torn
   * down deterministically instead of being abandoned mid-read.
   */
  private startPipe(
    stream: ReadableStream,
    writer: LogWriter,
    console: NodeJS.WriteStream | null,
    prefix: string,
  ): PipeHandle {
    const reader = stream.getReader();
    const cancel = async (): Promise<void> => {
      try {
        // Cancels the underlying source (applying backpressure to the child) and
        // wakes the parked `reader.read()` with `{ done: true }`.
        await reader.cancel();
      } catch {
        /* reader may already be released or the stream already cancelled */
      }
    };
    return { promise: this.consumeStream(reader, writer, console, prefix), cancel };
  }

  /**
   * Drain a stream reader, writing each chunk to the LogWriter and optionally
   * echoing to a NodeJS.WriteStream (console).
   */
  private async consumeStream(
    reader: ReadableStreamDefaultReader,
    writer: LogWriter,
    console: NodeJS.WriteStream | null,
    prefix: string,
  ): Promise<void> {
    const decoder = new TextDecoder();
    let pendingConsoleLine = '';
    let writeErrorLogged = false;

    // A normal end-of-stream surfaces as `{ done: true }` — never an error — so a
    // thrown error from `reader.read()` is unexpected (broken pipe, stream
    // errored, …) and is surfaced rather than classified by error-message
    // substrings. A failure from `writer.write()` (ENOSPC / EISDIR after
    // `rm -rf` of the log dir / EACCES / a throw from rotate()) is transient from
    // the pipe's point of view: we must keep draining the child's stream so the
    // OS pipe stays bounded and the worker can recover once the fault clears —
    // never abandon the stream un-consumed and let Bun buffer it into the heap.
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        try {
          await writer.write(value);
          writeErrorLogged = false;
        } catch (err: unknown) {
          if (!writeErrorLogged) {
            const msg = err instanceof Error ? err.message : String(err);
            process.stderr.write(`${prefix} log write error: ${msg}\n`);
            writeErrorLogged = true;
          }
        }

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
