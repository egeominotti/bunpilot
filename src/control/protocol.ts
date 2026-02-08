// ---------------------------------------------------------------------------
// bunpm2 – Control Protocol: NDJSON encoding/decoding & message factories
// ---------------------------------------------------------------------------

import type { ControlRequest, ControlResponse, ControlStreamChunk } from '../config/types';

// ---------------------------------------------------------------------------
// NDJSON encoding / decoding
// ---------------------------------------------------------------------------

/**
 * Encode an object as a single NDJSON line (JSON + newline).
 */
export function encodeMessage(msg: object): string {
  return JSON.stringify(msg) + '\n';
}

/**
 * Decode a buffer that may contain one or more NDJSON lines.
 * Blank lines and lines that fail to parse are silently skipped.
 */
export function decodeMessages(buffer: string): object[] {
  const results: object[] = [];

  const lines = buffer.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        results.push(parsed as object);
      }
    } catch {
      // malformed line – skip
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Message factories
// ---------------------------------------------------------------------------

/**
 * Create a `ControlRequest` with a generated UUID.
 */
export function createRequest(cmd: string, args: Record<string, unknown> = {}): ControlRequest {
  return {
    id: crypto.randomUUID(),
    cmd,
    args,
  };
}

/**
 * Create a successful `ControlResponse`.
 */
export function createResponse(id: string, data?: unknown): ControlResponse {
  return {
    id,
    ok: true,
    ...(data !== undefined && { data }),
  };
}

/**
 * Create an error `ControlResponse`.
 */
export function createErrorResponse(id: string, error: string): ControlResponse {
  return {
    id,
    ok: false,
    error,
  };
}

/**
 * Create a `ControlStreamChunk` used for streaming responses (logs, monit).
 */
export function createStreamChunk(id: string, data: unknown, done?: boolean): ControlStreamChunk {
  return {
    id,
    stream: true as const,
    data,
    ...(done !== undefined && { done }),
  };
}
