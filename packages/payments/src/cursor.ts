import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { InvalidCursorError } from './errors';

/** What a page is filtered by. The cursor is only valid for exactly these. */
export interface ListFilters {
  merchantId: string;
  state: string | null;
  search: string | null;
}

/** The last row of a page: created_at to the microsecond, and its ID as tie-breaker. */
export interface CursorPosition {
  createdAt: string;
  id: string;
}

const VERSION = 1;
const EXACT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Covers merchant, status and search, so a cursor can't be replayed against other results. */
function filterHash(filters: ListFilters): string {
  return createHash('sha256')
    .update(JSON.stringify([filters.merchantId, filters.state, filters.search]))
    .digest('base64url');
}

function sign(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** `base64url(JSON {v, createdAt, id, filterHash})` + "." + HMAC-SHA256 of that (spec §4.4). */
export function encodeCursor(
  secret: string,
  position: CursorPosition,
  filters: ListFilters,
): string {
  const payload = Buffer.from(
    JSON.stringify({
      v: VERSION,
      createdAt: position.createdAt,
      id: position.id,
      filterHash: filterHash(filters),
    }),
  ).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

/**
 * The position a cursor points at. Throws InvalidCursorError if it is
 * malformed, its signature does not verify, or it was issued for another
 * merchant or other filters. The signature is checked before anything inside
 * the cursor is trusted, in constant time.
 */
export function decodeCursor(secret: string, cursor: string, filters: ListFilters): CursorPosition {
  const parts = cursor.split('.');
  const [payload, signature] = parts;
  if (
    parts.length !== 2 ||
    !payload ||
    !signature ||
    !BASE64URL.test(payload) ||
    !BASE64URL.test(signature)
  ) {
    throw new InvalidCursorError();
  }
  const expected = Buffer.from(sign(secret, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new InvalidCursorError();
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidCursorError();
  }
  const { v, createdAt, id, filterHash: hash } = (decoded ?? {}) as Record<string, unknown>;
  if (
    v !== VERSION ||
    typeof createdAt !== 'string' ||
    !EXACT_TIMESTAMP.test(createdAt) ||
    typeof id !== 'string' ||
    !UUID.test(id) ||
    hash !== filterHash(filters)
  ) {
    throw new InvalidCursorError();
  }
  return { createdAt, id };
}
