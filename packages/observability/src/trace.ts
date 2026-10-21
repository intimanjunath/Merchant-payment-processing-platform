import { randomBytes } from 'node:crypto';

// W3C Trace Context: https://www.w3.org/TR/trace-context/#traceparent-header
export const TRACEPARENT_HEADER = 'traceparent';

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ZERO_TRACE_ID = '0'.repeat(32);
const ZERO_SPAN_ID = '0'.repeat(16);
const SAMPLED = '01';

export interface TraceContext {
  traceId: string;
  spanId: string;
  flags: string;
}

/** Parses a traceparent header. Returns undefined for anything malformed, as the spec requires. */
export function parseTraceparent(header: string | undefined): TraceContext | undefined {
  if (!header) return undefined;
  const match = TRACEPARENT_PATTERN.exec(header.trim());
  if (!match) return undefined;
  const [, version, traceId, spanId, flags, extra] = match;
  if (!version || !traceId || !spanId || !flags) return undefined;
  // Version ff is forbidden; version 00 has exactly four fields.
  if (version === 'ff' || (version === '00' && extra !== undefined)) return undefined;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return undefined;
  return { traceId, spanId, flags };
}

export function formatTraceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-${context.flags}`;
}

/**
 * Starts a span for this process: continues the caller's trace when a valid
 * parent is given, otherwise begins a new sampled trace.
 */
export function startSpan(parent?: TraceContext): TraceContext {
  return {
    traceId: parent?.traceId ?? randomHex(16),
    spanId: randomHex(8),
    flags: parent?.flags ?? SAMPLED,
  };
}

function randomHex(bytes: number): string {
  // All-zero IDs are invalid; the chance is negligible but cheap to rule out.
  for (;;) {
    const hex = randomBytes(bytes).toString('hex');
    if (!/^0+$/.test(hex)) return hex;
  }
}
