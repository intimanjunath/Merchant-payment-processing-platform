import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'x-request-id';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * Keeps a caller's request ID if it is safe to log and echo back; otherwise
 * generates one. A repeated header arrives as an array and is replaced.
 */
export function resolveRequestId(incoming: string | string[] | undefined): string {
  if (typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)) {
    return incoming;
  }
  return randomUUID();
}
