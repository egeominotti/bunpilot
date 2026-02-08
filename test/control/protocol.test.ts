// ---------------------------------------------------------------------------
// bunpilot – Control Protocol unit tests
// ---------------------------------------------------------------------------

import { describe, test, expect } from 'bun:test';
import {
  encodeMessage,
  decodeMessages,
  createRequest,
  createResponse,
  createErrorResponse,
  createStreamChunk,
} from '../../src/control/protocol';

describe('encodeMessage', () => {
  test('produces valid JSON followed by a newline', () => {
    const result = encodeMessage({ cmd: 'status' });
    expect(result.endsWith('\n')).toBe(true);
    expect(JSON.parse(result.trim())).toEqual({ cmd: 'status' });
  });

  test('handles nested objects', () => {
    const msg = { a: { b: [1, 2, 3] } };
    const result = encodeMessage(msg);
    expect(result.endsWith('\n')).toBe(true);
    expect(JSON.parse(result.trim())).toEqual(msg);
  });
});

describe('decodeMessages', () => {
  test('parses a single NDJSON line', () => {
    const input = '{"cmd":"status"}\n';
    const results = decodeMessages(input);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ cmd: 'status' });
  });

  test('parses multiple NDJSON lines', () => {
    const input = '{"a":1}\n{"b":2}\n{"c":3}\n';
    const results = decodeMessages(input);
    expect(results).toHaveLength(3);
    expect(results[0]).toEqual({ a: 1 });
    expect(results[1]).toEqual({ b: 2 });
    expect(results[2]).toEqual({ c: 3 });
  });

  test('skips blank lines', () => {
    const input = '{"a":1}\n\n\n{"b":2}\n';
    const results = decodeMessages(input);
    expect(results).toHaveLength(2);
  });

  test('skips malformed JSON lines', () => {
    const input = '{"valid":true}\nnot-json\n{"also":"valid"}\n';
    const results = decodeMessages(input);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ valid: true });
    expect(results[1]).toEqual({ also: 'valid' });
  });

  test('skips array lines (non-object)', () => {
    const input = '[1,2,3]\n{"obj":true}\n';
    const results = decodeMessages(input);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ obj: true });
  });
});

describe('createRequest', () => {
  test('generates a request with a unique id', () => {
    const req = createRequest('status');
    expect(req.id).toBeDefined();
    expect(typeof req.id).toBe('string');
    expect(req.id.length).toBeGreaterThan(0);
    expect(req.cmd).toBe('status');
    expect(req.args).toEqual({});
  });

  test('two calls produce different ids', () => {
    const r1 = createRequest('a');
    const r2 = createRequest('b');
    expect(r1.id).not.toBe(r2.id);
  });

  test('passes args through', () => {
    const req = createRequest('restart', { app: 'web', force: true });
    expect(req.args).toEqual({ app: 'web', force: true });
  });
});

describe('createResponse', () => {
  test('creates a success response with ok: true', () => {
    const res = createResponse('abc-123', { workers: 4 });
    expect(res.id).toBe('abc-123');
    expect(res.ok).toBe(true);
    expect(res.data).toEqual({ workers: 4 });
  });

  test('omits data when not provided', () => {
    const res = createResponse('abc-123');
    expect(res.ok).toBe(true);
    expect('data' in res).toBe(false);
  });
});

describe('createErrorResponse', () => {
  test('creates an error response with ok: false', () => {
    const res = createErrorResponse('abc-123', 'app not found');
    expect(res.id).toBe('abc-123');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('app not found');
  });
});

describe('createStreamChunk', () => {
  test('creates a chunk with stream: true', () => {
    const chunk = createStreamChunk('id-1', { line: 'log output' });
    expect(chunk.id).toBe('id-1');
    expect(chunk.stream).toBe(true);
    expect(chunk.data).toEqual({ line: 'log output' });
  });

  test('includes done flag when provided', () => {
    const chunk = createStreamChunk('id-1', null, true);
    expect(chunk.done).toBe(true);
  });

  test('omits done when not provided', () => {
    const chunk = createStreamChunk('id-1', 'data');
    expect('done' in chunk).toBe(false);
  });
});
