// Errors that mean the database could not be reached or dropped the
// connection, as opposed to a query that failed. The API answers these with
// 503: the work could not be durably accepted, and retrying later may succeed.

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

// SQLSTATE 57P01-57P03: the server is shutting down or not accepting connections yet.
const UNAVAILABLE_SQLSTATES = new Set(['57P01', '57P02', '57P03']);

// pg and pg-pool report these without a code.
const UNAVAILABLE_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated',
  'Cannot use a pool after calling end on the pool',
];

export function isDatabaseUnavailable(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message, errors } = error as {
    code?: unknown;
    message?: unknown;
    errors?: unknown;
  };

  if (typeof code === 'string') {
    // Class 08 is "connection exception".
    if (NETWORK_CODES.has(code) || UNAVAILABLE_SQLSTATES.has(code) || code.startsWith('08')) {
      return true;
    }
  }
  if (typeof message === 'string' && UNAVAILABLE_MESSAGES.some((text) => message.includes(text))) {
    return true;
  }
  // Node reports a refused connection to several addresses as an AggregateError.
  return Array.isArray(errors) && errors.some(isDatabaseUnavailable);
}
