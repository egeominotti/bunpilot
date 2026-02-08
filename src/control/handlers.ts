// ---------------------------------------------------------------------------
// bunpilot – Control Handlers: maps CLI commands to daemon actions
// ---------------------------------------------------------------------------

import type { ControlResponse, AppStatus } from '../config/types';
import { createResponse, createErrorResponse } from './protocol';

// ---------------------------------------------------------------------------
// CommandContext – interface the master must satisfy
// ---------------------------------------------------------------------------

/**
 * Subset of the `MasterOrchestrator` surface area that command handlers need.
 * This keeps the handlers decoupled from the full orchestrator implementation.
 */
export interface CommandContext {
  listApps(): AppStatus[];
  getApp(name: string): AppStatus | undefined;
  startApp(name: string): Promise<void>;
  stopApp(name: string): Promise<void>;
  restartApp(name: string): Promise<void>;
  reloadApp(name: string): Promise<void>;
  deleteApp(name: string): Promise<void>;
  getMetrics(): Record<string, unknown>;
  getLogs(name: string, lines?: number): string[];
  dumpState(): Record<string, unknown>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Handler type
// ---------------------------------------------------------------------------

export type Handler = (args: Record<string, unknown>) => Promise<ControlResponse>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `Map<string, Handler>` wired to the given `CommandContext`.
 * Each handler receives the request args and returns a `ControlResponse`.
 */
export function createCommandHandlers(ctx: CommandContext): Map<string, Handler> {
  const handlers = new Map<string, Handler>();

  // -- list ---------------------------------------------------------------
  handlers.set('list', async (_args) => {
    const apps = ctx.listApps();
    return createResponse('', apps);
  });

  // -- status -------------------------------------------------------------
  handlers.set('status', async (args) => {
    const name = extractName(args);
    if (!name) return missingName('');

    const app = ctx.getApp(name);
    if (!app) return appNotFound('', name);

    return createResponse('', app);
  });

  // -- start --------------------------------------------------------------
  handlers.set('start', async (args) => {
    const name = extractName(args);
    if (!name) return missingName('');

    try {
      await ctx.startApp(name);
      return createResponse('', { name, action: 'started' });
    } catch (err) {
      return createErrorResponse('', errorMessage(err));
    }
  });

  // -- stop ---------------------------------------------------------------
  handlers.set('stop', async (args) => {
    const name = extractName(args);
    if (!name) return missingName('');

    try {
      await ctx.stopApp(name);
      return createResponse('', { name, action: 'stopped' });
    } catch (err) {
      return createErrorResponse('', errorMessage(err));
    }
  });

  // -- restart ------------------------------------------------------------
  handlers.set('restart', async (args) => {
    const name = extractName(args);
    if (!name) return missingName('');

    try {
      await ctx.restartApp(name);
      return createResponse('', { name, action: 'restarted' });
    } catch (err) {
      return createErrorResponse('', errorMessage(err));
    }
  });

  // -- reload (graceful / zero-downtime) -----------------------------------
  handlers.set('reload', async (args) => {
    const name = extractName(args);
    if (!name) return missingName('');

    try {
      await ctx.reloadApp(name);
      return createResponse('', { name, action: 'reloaded' });
    } catch (err) {
      return createErrorResponse('', errorMessage(err));
    }
  });

  // -- delete -------------------------------------------------------------
  handlers.set('delete', async (args) => {
    const name = extractName(args);
    if (!name) return missingName('');

    try {
      await ctx.deleteApp(name);
      return createResponse('', { name, action: 'deleted' });
    } catch (err) {
      return createErrorResponse('', errorMessage(err));
    }
  });

  // -- metrics ------------------------------------------------------------
  handlers.set('metrics', async (_args) => {
    const metrics = ctx.getMetrics();
    return createResponse('', metrics);
  });

  // -- logs ---------------------------------------------------------------
  handlers.set('logs', async (args) => {
    const name = extractName(args);
    if (!name) return missingName('');

    const lines = typeof args.lines === 'number' ? args.lines : undefined;
    const logLines = ctx.getLogs(name, lines);
    return createResponse('', logLines);
  });

  // -- ping ---------------------------------------------------------------
  handlers.set('ping', async (_args) => {
    return createResponse('', { pong: true, ts: Date.now() });
  });

  // -- dump ---------------------------------------------------------------
  handlers.set('dump', async (_args) => {
    const state = ctx.dumpState();
    return createResponse('', state);
  });

  // -- kill-daemon --------------------------------------------------------
  handlers.set('kill-daemon', async (_args) => {
    // Respond before initiating shutdown so the client gets an ack
    const response = createResponse('', { action: 'shutting-down' });

    // Schedule shutdown with a short delay so the response is flushed first
    setTimeout(() => {
      ctx.shutdown().catch((err) => {
        console.error('[control-handlers] shutdown error:', err);
      });
    }, 100);

    return response;
  });

  return handlers;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractName(args: Record<string, unknown>): string | null {
  const name = args.name;
  return typeof name === 'string' && name.length > 0 ? name : null;
}

function missingName(id: string): ControlResponse {
  return createErrorResponse(id, 'Missing required argument: name');
}

function appNotFound(id: string, name: string): ControlResponse {
  return createErrorResponse(id, `App not found: ${name}`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
