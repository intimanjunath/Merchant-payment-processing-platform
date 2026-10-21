import { stdSerializers } from 'pino';

export const REDACTED = '[REDACTED]';

// Compared after lower-casing and dropping '-' and '_', so `set-cookie`,
// `payment_method_token` and `csrfToken` all match.
const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'authorization',
  'cookie',
  'setcookie',
  'accesstoken',
  'refreshtoken',
  'csrftoken',
  'idtoken',
  'jwt',
  'paymentmethod',
  'paymentmethodtoken',
  'cardnumber',
  'pan',
  'cvv',
  'cvc',
  'secret',
]);

const SENSITIVE_SUFFIXES = ['password', 'secret', 'token'];

const MAX_DEPTH = 10;

export function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, '');
  return (
    SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/**
 * Returns a copy of `value` with sensitive keys replaced at any depth. Errors are
 * serialized first (message, stack, custom fields, cause) so their fields are
 * checked too. The input is never modified.
 */
export function redact(value: unknown): unknown {
  return redactValue(value, 0, new WeakSet());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return '[Circular]';
  }
  if (depth >= MAX_DEPTH) {
    return '[Truncated]';
  }
  seen.add(value);
  try {
    if (value instanceof Error) {
      return redactValue(stdSerializers.err(value), depth, seen);
    }
    if (Array.isArray(value)) {
      return value.map((item: unknown) => redactValue(item, depth + 1, seen));
    }
    if (value instanceof Date) {
      return value;
    }
    const copy: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      copy[key] = isSensitiveKey(key) ? REDACTED : redactValue(inner, depth + 1, seen);
    }
    return copy;
  } finally {
    seen.delete(value);
  }
}
