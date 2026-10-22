import { listPayments } from '@payments/db';
import type { Pool } from 'pg';

import { decodeCursor, encodeCursor, type ListFilters } from './cursor';
import { toPaymentResource } from './resources';

export interface ListQuery {
  status?: string;
  q?: string;
  limit: number;
  cursor?: string;
}

/**
 * GET /payments: one page of the merchant's payments, newest first, with a
 * cursor for the next page when there is one. One extra row is read to know.
 */
export async function listPaymentsPage(
  deps: { pool: Pool; cursorSecret: string },
  merchantId: string,
  query: ListQuery,
) {
  const filters: ListFilters = { merchantId, state: query.status ?? null, search: query.q ?? null };
  const after =
    query.cursor === undefined ? null : decodeCursor(deps.cursorSecret, query.cursor, filters);

  const rows = await listPayments(deps.pool, { ...filters, after, limit: query.limit + 1 });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const nextCursor =
    rows.length > query.limit && last
      ? encodeCursor(deps.cursorSecret, { createdAt: last.cursorCreatedAt, id: last.id }, filters)
      : null;

  return { items: page.map(toPaymentResource), nextCursor };
}
