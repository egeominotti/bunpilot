// ---------------------------------------------------------------------------
// bunpm – Shared Daemon Connection Helper
// ---------------------------------------------------------------------------
//
// Extracted into a single module so all command files can reuse the same
// ControlClient creation, error handling, and response formatting logic.
// ---------------------------------------------------------------------------

import { ControlClient } from '../../control/client';
import { SOCKET_PATH } from '../../constants';
import type { ControlResponse, ControlStreamChunk } from '../../config/types';
import { logError, logSuccess } from '../format';

// ---------------------------------------------------------------------------
// Client Factory
// ---------------------------------------------------------------------------

/**
 * Create a ControlClient connected to the daemon socket.
 * Uses SOCKET_PATH from constants by default, but can be overridden
 * via the --socket flag if needed in the future.
 */
export function createClient(socketPath?: string): ControlClient {
  return new ControlClient(socketPath ?? SOCKET_PATH);
}

// ---------------------------------------------------------------------------
// Send & Handle Response
// ---------------------------------------------------------------------------

/**
 * Send a command to the daemon and handle the response uniformly.
 *
 * On success: prints a message and returns the response data.
 * On failure: prints the error and exits with code 1.
 */
export async function sendCommand(
  cmd: string,
  args?: Record<string, unknown>,
  opts?: { silent?: boolean },
): Promise<ControlResponse> {
  const client = createClient();

  try {
    const res = await client.send(cmd, args);

    if (!res.ok) {
      logError(res.error ?? `Command "${cmd}" failed`);
      process.exit(1);
    }

    if (!opts?.silent) {
      logSuccess(`${cmd} completed`);
    }

    return res;
  } catch (err) {
    logError(formatError(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Stream Helper
// ---------------------------------------------------------------------------

/**
 * Send a streaming command to the daemon and forward each chunk to a callback.
 * On error, prints the message and exits.
 */
export async function sendStreamCommand(
  cmd: string,
  args: Record<string, unknown> | undefined,
  onChunk: (chunk: ControlStreamChunk) => void,
): Promise<void> {
  const client = createClient();

  try {
    await client.sendStream(cmd, args, onChunk);
  } catch (err) {
    logError(formatError(err));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Require that a positional argument is present.
 * Prints a usage error and exits if missing.
 */
export function requireArg(args: string[], label: string): string {
  const value = args[0];
  if (!value) {
    logError(`Missing required argument: <${label}>`);
    process.exit(1);
  }
  return value;
}

/**
 * Safely format an unknown error into a string.
 */
function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
