import { randomUUID } from 'node:crypto';

import { createPool, LIST_PAYMENTS_SQL, substringPattern } from '@payments/db';
import argon2 from 'argon2';
import type { Pool } from 'pg';
import request from 'supertest';

import { startTestApi, type TestApi } from '../helpers/api';
import { conforms } from '../helpers/openapi';
import { createScratchDatabase } from '../helpers/test-db';

const PASSWORD = 'list-test-password';

interface ListBody {
  items: { id: string; state: string; reference: string }[];
  nextCursor: string | null;
}

describe('GET /payments', () => {
  let scratch: { url: string; drop: () => Promise<void> };
  let api: TestApi;
  let db: Pool;
  const merchants: { id: string; token: string }[] = [];
  const server = () => api.app.getHttpServer();

  /** A merchant only this suite uses, so the list holds exactly the rows seeded here. */
  async function newMerchant(): Promise<{ id: string; token: string }> {
    const email = `list-${randomUUID()}@example.test`;
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    const row = await db.query<{ id: string }>(
      `INSERT INTO merchants (email, name, password_hash) VALUES ($1, 'List Test', $2) RETURNING id`,
      [email, hash],
    );
    const login = await request(server())
      .post('/auth/token')
      .send({ email, password: PASSWORD })
      .expect(200);
    const merchant = { id: row.rows[0]?.id ?? '', token: String(login.body.accessToken) };
    merchants.push(merchant);
    return merchant;
  }

  /** Inserts payments with exact created_at values (microseconds included). */
  async function seed(
    merchantId: string,
    rows: { createdAt: string; state?: string; reference?: string }[],
  ) {
    for (const row of rows) {
      const state = row.state ?? 'authorized';
      await db.query(
        `INSERT INTO payments (merchant_id, amount_cents, reference, payment_method_token, card_brand,
                               card_last4, state, failure_reason, created_at, updated_at)
         VALUES ($1, 1000, $2, 'pm_card_visa', 'visa', '4242', $3, $4, $5, $5)`,
        [
          merchantId,
          row.reference ?? `ref-${randomUUID()}`,
          state,
          state === 'failed' ? 'card_declined' : null,
          row.createdAt,
        ],
      );
    }
  }

  const expectedOrder = async (merchantId: string, where = 'TRUE', params: unknown[] = []) =>
    (
      await db.query<{ id: string }>(
        `SELECT id FROM payments WHERE merchant_id = $1 AND ${where} ORDER BY created_at DESC, id DESC`,
        [merchantId, ...params],
      )
    ).rows.map((row) => row.id);

  async function list(token: string, query: Record<string, string | number> = {}) {
    const res = await request(server())
      .get('/payments')
      .query(query)
      .set('Authorization', `Bearer ${token}`);
    return conforms(res, 'get', '/payments');
  }

  /** Follows nextCursor to the end and returns every ID in the order served. */
  async function allPages(token: string, query: Record<string, string | number>) {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 100; page += 1) {
      const res = await list(token, cursor ? { ...query, cursor } : query);
      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      ids.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
      if (!cursor) return ids;
    }
    throw new Error('paging did not end');
  }

  // A database of its own: the suite inserts hundreds of rows, and deleting them from the
  // shared test database (whose jobs table grows run after run) outlasted the hook timeout.
  beforeAll(async () => {
    scratch = await createScratchDatabase({ seed: true });
    api = await startTestApi({ databaseUrl: scratch.url });
    db = createPool(scratch.url, { applicationName: 'payments-list-test', max: 2 });
  });

  afterAll(async () => {
    await db.end();
    await api.app.close();
    await scratch.drop();
  });

  describe('paging', () => {
    let merchant: { id: string; token: string };

    beforeAll(async () => {
      merchant = await newMerchant();
      const states = ['pending', 'authorized', 'captured', 'settled', 'failed', 'refunded'];
      await seed(merchant.id, [
        // Three payments created in the same instant: only the ID orders them.
        ...[0, 1, 2].map(() => ({ createdAt: '2026-01-01T00:00:00.000000Z' })),
        // Three within one millisecond: a cursor rounded to milliseconds would skip or repeat them.
        { createdAt: '2026-01-02T00:00:00.123100Z' },
        { createdAt: '2026-01-02T00:00:00.123400Z' },
        { createdAt: '2026-01-02T00:00:00.123700Z' },
        ...Array.from({ length: 30 }, (_, i) => ({
          createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, i)).toISOString(),
          state: states[i % states.length],
        })),
      ]);
    });

    it('serves every payment exactly once, newest first, across pages', async () => {
      const expected = await expectedOrder(merchant.id);

      const served = await allPages(merchant.token, { limit: 4 });

      expect(expected).toHaveLength(36);
      expect(served).toEqual(expected);
    });

    it('pages one row at a time through ties and microsecond gaps', async () => {
      expect(await allPages(merchant.token, { limit: 1 })).toEqual(
        await expectedOrder(merchant.id),
      );
    });

    it('defaults to 25 per page, and ends with a null cursor', async () => {
      const first = (await list(merchant.token)).body as ListBody;
      const second = (await list(merchant.token, { cursor: String(first.nextCursor) }))
        .body as ListBody;

      expect(first.items).toHaveLength(25);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(second.items).toHaveLength(11);
      expect(second.nextCursor).toBeNull();
    });

    it('filters by status, and pages within the filter', async () => {
      const served = await allPages(merchant.token, { status: 'captured', limit: 2 });

      expect(served).toEqual(await expectedOrder(merchant.id, 'state = $2', ['captured']));
      expect(served).toHaveLength(5);
    });

    it('gives no cursor when a page ends exactly on the last payment', async () => {
      const page = (await list(merchant.token, { status: 'captured', limit: 5 })).body as ListBody;

      expect(page.items).toHaveLength(5);
      expect(page.nextCursor).toBeNull();
    });

    it('serves 100 per page at most and refuses more', async () => {
      expect((await list(merchant.token, { limit: 100 })).status).toBe(200);
      for (const limit of [0, 101, 'abc', 1.5, -1]) {
        const res = await list(merchant.token, { limit });
        expect(res.status).toBe(400);
        expect(res.body.error.details.fields).toEqual([
          expect.objectContaining({ field: 'limit' }),
        ]);
      }
    });
  });

  describe('search', () => {
    let merchant: { id: string; token: string };

    beforeAll(async () => {
      merchant = await newMerchant();
      await seed(
        merchant.id,
        [
          'promo%50',
          'promoX50',
          'under_score',
          'underXscore',
          'Mixed-Case-Ref',
          'back\\slash',
          'other',
        ].map((reference, i) => ({
          reference,
          createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i)).toISOString(),
        })),
      );
    });

    const references = async (q: string) =>
      ((await list(merchant.token, { q })).body as ListBody).items
        .map((item) => item.reference)
        .sort();

    it('matches a case-insensitive substring of the reference', async () => {
      expect(await references('mixed-case')).toEqual(['Mixed-Case-Ref']);
      expect(await references('promo')).toEqual(['promo%50', 'promoX50']);
    });

    it('treats %, _ and backslash as plain characters', async () => {
      expect(await references('%')).toEqual(['promo%50']);
      expect(await references('o%5')).toEqual(['promo%50']);
      expect(await references('r_s')).toEqual(['under_score']);
      expect(await references('\\')).toEqual(['back\\slash']);
    });

    it.each([
      ['an empty q', { q: '' }, 'q'],
      ['a q over 100 characters', { q: 'x'.repeat(101) }, 'q'],
      ['an unknown status', { status: 'voided' }, 'status'],
      ['an unknown parameter', { sort: 'amount' }, 'sort'],
    ])('answers 400 for %s', async (_label, query, field) => {
      const res = await list(merchant.token, query);

      expect(res.status).toBe(400);
      expect(res.body.error.details.fields).toEqual(
        expect.arrayContaining([expect.objectContaining({ field })]),
      );
    });
  });

  describe('cursors', () => {
    let merchant: { id: string; token: string };
    let other: { id: string; token: string };

    beforeAll(async () => {
      merchant = await newMerchant();
      other = await newMerchant();
      const rows = Array.from({ length: 6 }, (_, i) => ({
        createdAt: new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString(),
        state: i % 2 === 0 ? 'authorized' : 'captured',
        reference: `abc-${String(i)}`,
      }));
      await seed(merchant.id, rows);
      await seed(other.id, rows);
    });

    const cursorFor = async (query: Record<string, string | number>) =>
      String(((await list(merchant.token, { ...query, limit: 1 })).body as ListBody).nextCursor);

    it.each([
      ['another status', { status: 'authorized' }, { status: 'captured' }],
      ['no status', { status: 'authorized' }, {}],
      ['a status added', {}, { status: 'authorized' }],
      ['another search', { q: 'abc' }, { q: 'abd' }],
    ])('refuses a cursor reused with %s', async (_label, issuedFor, usedWith) => {
      const cursor = await cursorFor(issuedFor);

      const res = await list(merchant.token, { ...usedWith, cursor });

      expect(res.status).toBe(400);
      expect(res.body.error.details.fields).toEqual([
        { field: 'cursor', issue: 'is not valid for this query' },
      ]);
    });

    it("refuses another merchant's cursor", async () => {
      const res = await list(other.token, { cursor: await cursorFor({}) });

      expect(res.status).toBe(400);
    });

    it('refuses a tampered or made-up cursor', async () => {
      const cursor = await cursorFor({});
      const [payload, signature] = cursor.split('.');
      const flipped = `${String(payload)}.${String(signature).slice(0, -1)}${signature?.endsWith('A') ? 'B' : 'A'}`;

      for (const bad of [flipped, 'not-a-cursor', `${String(payload)}.`, 'x'.repeat(600)]) {
        expect((await list(merchant.token, { cursor: bad })).status).toBe(400);
      }
    });

    it("never shows another merchant's payments", async () => {
      const served = await allPages(merchant.token, { limit: 2 });

      expect(served).toEqual(await expectedOrder(merchant.id));
      expect(served).not.toEqual(expect.arrayContaining(await expectedOrder(other.id)));
    });
  });

  it('answers 401 without a credential', async () => {
    const res = conforms(await request(server()).get('/payments'), 'get', '/payments');

    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  describe('query plan', () => {
    it('uses the trigram index for a reference search on a large table', async () => {
      const merchant = await newMerchant();
      await db.query(
        `INSERT INTO payments (merchant_id, amount_cents, reference, payment_method_token, card_brand,
                               card_last4, state, created_at, updated_at)
         SELECT $1, 1000,
                CASE WHEN n % 5000 = 0 THEN 'needle-' || n ELSE 'bulk-order-' || n END,
                'pm_card_visa', 'visa', '4242', 'authorized',
                timestamptz '2026-04-01' + n * interval '1 second',
                timestamptz '2026-04-01' + n * interval '1 second'
           FROM generate_series(1, 20000) AS n`,
        [merchant.id],
      );
      // As autovacuum would: flush the GIN pending list and refresh statistics.
      // Fresh inserts (and rows other runs deleted) otherwise sit in the pending
      // list and make the index look more expensive than it is in steady state.
      await db.query('VACUUM (ANALYZE) payments');

      const params = [merchant.id, null, substringPattern('needle'), null, null, 26];
      const plan = (
        await db.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${LIST_PAYMENTS_SQL}`, params)
      ).rows
        .map((row) => row['QUERY PLAN'])
        .join('\n');
      const found = await list(merchant.token, { q: 'needle' });

      expect(plan).toContain('payments_reference_trgm_idx');
      expect((found.body as ListBody).items.map((item) => item.reference).sort()).toEqual([
        'needle-10000',
        'needle-15000',
        'needle-20000',
        'needle-5000',
      ]);
      process.stdout.write(`\nEXPLAIN (q = needle):\n${plan}\n`);
    });
  });
});
