import { randomUUID } from 'node:crypto';

import { createPool, migrate } from '@payments/db';
import { PAYMENT_STATES } from '@payments/payments';
import { Client, type Pool } from 'pg';

import { testDatabaseUrl } from '../helpers/test-db';

/** Runs `work` and returns the PostgreSQL error it fails with. */
async function pgError(work: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await work;
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error('Expected the statement to fail');
}

// A fresh database inside test-db, so the migrations are applied to an empty schema.
describe('migration 002_payments on an empty database', () => {
  const databaseName = `schema_check_${randomUUID().replaceAll('-', '')}`;
  let admin: Client;
  let pool: Pool;
  let firstRun: string[];
  let secondRun: string[];
  let merchantId: string;

  beforeAll(async () => {
    admin = new Client({ connectionString: testDatabaseUrl() });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${databaseName}`);
    const url = new URL(testDatabaseUrl());
    url.pathname = `/${databaseName}`;
    pool = createPool(url.toString(), { applicationName: 'schema-check', max: 2 });

    firstRun = await migrate(pool);
    secondRun = await migrate(pool);
    const merchant = await pool.query<{ id: string }>(
      `INSERT INTO merchants (email, name, password_hash) VALUES ('m@example.test', 'M', 'x') RETURNING id`,
    );
    merchantId = merchant.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
    await admin.end();
  });

  const insertPayment = (overrides: Record<string, unknown> = {}) => {
    const row = {
      merchant_id: merchantId,
      amount_cents: 1250,
      reference: 'order-1',
      payment_method_token: 'pm_card_visa',
      card_brand: 'visa',
      card_last4: '4242',
      state: 'pending',
      ...overrides,
    };
    const columns = Object.keys(row);
    return pool.query<{ id: string }>(
      `INSERT INTO payments (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${String(i + 1)}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
  };

  const paymentId = async () => (await insertPayment()).rows[0]?.id ?? '';

  const insertOperation = (payment: string, key: string, status = 'reserved') =>
    pool.query<{ id: string }>(
      `INSERT INTO operations (merchant_id, payment_id, action, idempotency_scope, idempotency_key,
                               request_hash, provider_key, expected_version, status, request_id,
                               completed_at)
       VALUES ($1, $2, 'capture', $6, $3, 'hash', $4, 0, $5, 'req-1',
               CASE WHEN $5 IN ('succeeded', 'rejected') THEN now() END)
       RETURNING id`,
      [merchantId, payment, key, randomUUID(), status, `capture:${payment}`],
    );

  it('applies both migrations once, and a second run does nothing', () => {
    expect(firstRun).toEqual(['001_auth.sql', '002_payments.sql']);
    expect(secondRun).toEqual([]);
  });

  it('creates the tables and indexes from spec §5.3', async () => {
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`,
    );

    expect(tables.rows.map((row) => row.tablename)).toEqual(
      expect.arrayContaining(['audit_events', 'jobs', 'operations', 'payments']),
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'payments_merchant_created_idx',
        'payments_merchant_state_created_idx',
        'payments_reference_trgm_idx',
        'payments_provider_payment_id_key',
        'operations_idempotency_key',
        'operations_one_unresolved_per_payment',
        'operations_payment_created_idx',
        'jobs_queued_due_idx',
        'jobs_running_lease_idx',
        'jobs_paused_idx',
        'audit_events_payment_time_idx',
      ]),
    );
  });

  it('allows exactly the states the transition table knows', async () => {
    const check = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'payments'::regclass AND conname = 'payments_state_check'`,
    );
    const states = [...(check.rows[0]?.definition ?? '').matchAll(/'([a-z_]+)'::text/g)].map(
      (match) => match[1],
    );

    expect(states.sort()).toEqual([...PAYMENT_STATES].sort());
  });

  it.each([
    ['a zero amount', { amount_cents: 0 }],
    ['an amount over the limit', { amount_cents: 100_000_001 }],
    ['a currency other than USD', { currency: 'EUR' }],
    ['an empty reference', { reference: '' }],
    ['a last4 that is not four digits', { card_last4: '42a2' }],
    ['an unknown state', { state: 'voided' }],
    ['failed without a reason', { state: 'failed' }],
    ['a reason on a payment that has not failed', { failure_reason: 'declined' }],
  ])('rejects a payment with %s', async (_label, overrides) => {
    expect(await pgError(insertPayment(overrides))).toMatchObject({ code: '23514' });
  });

  it('accepts a failed payment with its reason', async () => {
    await insertPayment({ state: 'failed', failure_reason: 'card_declined' });
  });

  it('allows one unresolved operation per payment, and another once it resolves', async () => {
    const payment = await paymentId();
    const first = await insertOperation(payment, 'key-1');

    expect(await pgError(insertOperation(payment, 'key-2'))).toMatchObject({
      code: '23505',
      constraint: 'operations_one_unresolved_per_payment',
    });
    await pool.query(
      `UPDATE operations SET status = 'succeeded', completed_at = now() WHERE id = $1`,
      [first.rows[0]?.id],
    );
    await insertOperation(payment, 'key-2');
  });

  it('keeps paused work blocking new mutations', async () => {
    const payment = await paymentId();
    await insertOperation(payment, 'key-1', 'needs_review');

    expect(await pgError(insertOperation(payment, 'key-2'))).toMatchObject({
      constraint: 'operations_one_unresolved_per_payment',
    });
  });

  it('refuses a reused idempotency key in the same scope and a malformed key', async () => {
    const payment = await paymentId();
    await insertOperation(payment, 'key-1', 'succeeded');

    expect(await pgError(insertOperation(payment, 'key-1', 'succeeded'))).toMatchObject({
      code: '23505',
      constraint: 'operations_idempotency_key',
    });
    expect(await pgError(insertOperation(payment, 'has space', 'succeeded'))).toMatchObject({
      code: '23514',
    });
  });

  it('refuses a running job without a lease and a recovery job without an operation', async () => {
    const payment = await paymentId();
    const insertJob = (type: string, status: string) =>
      pool.query(
        `INSERT INTO jobs (type, work_key, payment_id, status, due_at, review_deadline, request_id)
         VALUES ($1, $2, $3, $4, now(), now() + interval '30 minutes', 'req-1')`,
        [type, `${type}:${randomUUID()}`, payment, status],
      );

    expect(await pgError(insertJob('settlement', 'running'))).toMatchObject({ code: '23514' });
    expect(await pgError(insertJob('operation_recovery', 'queued'))).toMatchObject({
      code: '23514',
    });
    await insertJob('settlement', 'queued');
  });

  it('keeps the audit trail append-only and one row per state entered', async () => {
    const payment = await paymentId();
    const insertAudit = (toState: string) =>
      pool.query<{ id: string }>(
        `INSERT INTO audit_events (payment_id, merchant_id, to_state, actor, source, reason, request_id)
         VALUES ($1, $2, $3, $4, 'api', 'test', 'req-1') RETURNING id`,
        [payment, merchantId, toState, `merchant:${merchantId}`],
      );
    const created = await insertAudit('pending');
    const id = created.rows[0]?.id;

    expect(await pgError(insertAudit('pending'))).toMatchObject({ code: '23505' });
    expect(
      await pgError(pool.query(`UPDATE audit_events SET reason = 'edited' WHERE id = $1`, [id])),
    ).toMatchObject({ code: 'P0001', message: 'audit_events is append-only' });
    expect(await pgError(pool.query(`DELETE FROM audit_events WHERE id = $1`, [id]))).toMatchObject(
      { code: 'P0001', message: 'audit_events is append-only' },
    );
  });
});
