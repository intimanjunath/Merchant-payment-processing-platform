import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { createPool } from '@payments/db';
import { createLogger } from '@payments/observability';
import {
  IdempotencyConflictError,
  InvalidStateTransitionError,
  type MutationContext,
  OperationInProgressError,
  PAYMENT_STATES,
  PaymentNotFoundError,
  type PaymentState,
  type Reservation,
  type ReservationDeps,
  reserveAction,
  reserveCreate,
  UnknownPaymentMethodError,
} from '@payments/payments';
import { createFakeProvider } from '@payments/provider';
import type { Pool } from 'pg';

import { migrateTestDatabase, SEEDED_MERCHANTS } from '../helpers/api';
import { testDatabaseUrl } from '../helpers/test-db';

const LEASE_OWNER = 'api:test';
const ALLOWED: Record<'capture' | 'refund', PaymentState> = {
  capture: 'authorized',
  refund: 'settled',
};

describe('reservation', () => {
  let pool: Pool;
  let deps: ReservationDeps;
  let acmeId: string;
  let bicycleId: string;
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    await migrateTestDatabase({ seed: true });
    pool = createPool(testDatabaseUrl(), { applicationName: 'reservation-test', max: 20 });
    // Open the connections up front so "concurrent" requests really overlap.
    const clients = await Promise.all(Array.from({ length: 12 }, () => pool.connect()));
    for (const client of clients) client.release();

    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        logs.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
        done();
      },
    });
    deps = {
      pool,
      provider: createFakeProvider(pool, { timeoutMs: 100, settlementDelayMs: 0 }),
      logger: createLogger({ service: 'api', level: 'debug', destination }),
      leaseOwner: LEASE_OWNER,
      leaseSeconds: 30,
      reviewDeadlineSeconds: 1_800,
    };
    const merchants = await pool.query<{ id: string; email: string }>(
      'SELECT id, email FROM merchants',
    );
    const idOf = (email: string) => merchants.rows.find((row) => row.email === email)?.id ?? '';
    acmeId = idOf(SEEDED_MERCHANTS.acme.email);
    bicycleId = idOf(SEEDED_MERCHANTS.bicycle.email);
  });

  afterAll(async () => {
    await pool.end();
  });

  const context = (overrides: Partial<MutationContext> = {}): MutationContext => ({
    merchantId: acmeId,
    idempotencyKey: `key-${randomUUID()}`,
    requestId: `req-${randomUUID()}`,
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    ...overrides,
  });

  const createInput = (overrides = {}) => ({
    amount: 1500,
    reference: `order-${randomUUID()}`,
    paymentMethod: 'pm_card_visa',
    ...overrides,
  });

  const count = async (sql: string, params: unknown[]) =>
    Number((await pool.query<{ n: string }>(sql, params)).rows[0]?.n);
  const paymentsOf = (merchantId: string) =>
    count('SELECT count(*) AS n FROM payments WHERE merchant_id = $1', [merchantId]);
  const operationsOn = (paymentId: string) =>
    count('SELECT count(*) AS n FROM operations WHERE payment_id = $1', [paymentId]);
  const auditRowsOf = (paymentId: string) =>
    count('SELECT count(*) AS n FROM audit_events WHERE payment_id = $1', [paymentId]);

  /** A payment already in `state`, as earlier finalizations would have left it. */
  async function paymentIn(
    state: PaymentState,
    options: { merchantId?: string; version?: number } = {},
  ) {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO payments (merchant_id, amount_cents, reference, payment_method_token, card_brand,
                             card_last4, state, failure_reason, provider_payment_id, version)
       VALUES ($1, 1500, $2, 'pm_card_visa', 'visa', '4242', $3, $4, $5, $6) RETURNING id`,
      [
        options.merchantId ?? acmeId,
        `fixture-${randomUUID()}`,
        state,
        state === 'failed' ? 'card_declined' : null,
        state === 'pending' || state === 'failed' ? null : `ch_${randomUUID().replaceAll('-', '')}`,
        options.version ?? 1,
      ],
    );
    return result.rows[0]?.id ?? '';
  }

  /** Alternates letter case: the same UUID in a third spelling. */
  const mixedCase = (id: string) =>
    id.replace(/[a-f]/g, (letter, offset: number) =>
      offset % 2 === 0 ? letter.toUpperCase() : letter,
    );

  const reserved = (reservation: Reservation) => {
    if (reservation.kind !== 'reserved')
      throw new Error(`expected a reservation, got ${reservation.kind}`);
    return reservation;
  };

  describe('create', () => {
    it('writes the payment, operation, leased job and creation audit together', async () => {
      const ctx = context();
      const input = createInput({ reference: '  padded-ref  ' });

      const { payment, operation, job } = reserved(await reserveCreate(deps, ctx, input));

      expect(payment).toMatchObject({
        merchantId: acmeId,
        state: 'pending',
        version: 0,
        amountCents: 1500,
        reference: 'padded-ref',
        cardBrand: 'visa',
        cardLast4: '4242',
        failureReason: null,
      });
      expect(operation).toMatchObject({
        paymentId: payment.id,
        action: 'authorize',
        status: 'reserved',
        idempotencyScope: 'create',
        idempotencyKey: ctx.idempotencyKey,
        expectedVersion: 0,
        requestId: ctx.requestId,
        traceparent: ctx.traceparent,
        providerKey: expect.stringMatching(/^pk_/),
      });
      expect(job).toMatchObject({
        type: 'operation_recovery',
        workKey: `recover:${operation.id}`,
        operationId: operation.id,
        status: 'running',
        leaseOwner: LEASE_OWNER,
        leaseGeneration: 1,
        attempts: 0,
        requestId: ctx.requestId,
        traceparent: ctx.traceparent,
      });
      expect((job.leaseExpiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(25_000);
      const audit = await pool.query(
        `SELECT from_state, to_state, actor, source, reason, operation_id, request_id
           FROM audit_events WHERE payment_id = $1`,
        [payment.id],
      );
      expect(audit.rows).toEqual([
        {
          from_state: null,
          to_state: 'pending',
          actor: `merchant:${acmeId}`,
          source: 'api',
          reason: 'create_accepted',
          operation_id: operation.id,
          request_id: ctx.requestId,
        },
      ]);
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: 'operation.reserved',
          paymentId: payment.id,
          operationId: operation.id,
          jobId: job.id,
        }),
      );
    });

    it('replays the same key and input, whatever the property order or padding', async () => {
      const ctx = context();
      const input = createInput();
      const first = reserved(await reserveCreate(deps, ctx, input));
      const before = await paymentsOf(acmeId);

      const again = await reserveCreate(deps, ctx, {
        paymentMethod: input.paymentMethod,
        reference: ` ${input.reference} `,
        amount: input.amount,
      });

      expect(again).toMatchObject({ kind: 'replay', operation: { id: first.operation.id } });
      expect(again.payment.id).toBe(first.payment.id);
      expect(await paymentsOf(acmeId)).toBe(before);
    });

    it('refuses the same key with a different input and writes nothing', async () => {
      const ctx = context();
      const first = reserved(await reserveCreate(deps, ctx, createInput()));
      const before = await paymentsOf(acmeId);

      await expect(reserveCreate(deps, ctx, createInput({ amount: 1600 }))).rejects.toEqual(
        expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT', operationId: first.operation.id }),
      );
      await expect(reserveCreate(deps, ctx, createInput({ amount: 1600 }))).rejects.toBeInstanceOf(
        IdempotencyConflictError,
      );
      expect(await paymentsOf(acmeId)).toBe(before);
    });

    it('keeps keys separate per merchant', async () => {
      const key = `shared-${randomUUID()}`;
      const input = createInput();

      const acme = reserved(await reserveCreate(deps, context({ idempotencyKey: key }), input));
      const bicycle = reserved(
        await reserveCreate(deps, context({ idempotencyKey: key, merchantId: bicycleId }), input),
      );

      expect(bicycle.payment.id).not.toBe(acme.payment.id);
      expect(bicycle.payment.merchantId).toBe(bicycleId);
    });

    it('refuses an unknown payment method before writing anything', async () => {
      const before = await paymentsOf(acmeId);

      await expect(
        reserveCreate(deps, context(), createInput({ paymentMethod: '4242424242424242' })),
      ).rejects.toBeInstanceOf(UnknownPaymentMethodError);
      expect(await paymentsOf(acmeId)).toBe(before);
    });

    it('gives ten concurrent requests with one key a single payment', async () => {
      const ctx = context();
      const input = createInput();
      const before = await paymentsOf(acmeId);

      const results = await Promise.all(
        Array.from({ length: 10 }, () => reserveCreate(deps, ctx, input)),
      );

      expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(1);
      expect(results.filter((result) => result.kind === 'replay')).toHaveLength(9);
      expect(new Set(results.map((result) => result.operation.id)).size).toBe(1);
      expect(await paymentsOf(acmeId)).toBe(before + 1);
    });
  });

  describe.each(['capture', 'refund'] as const)('%s', (action) => {
    it(`reserves from ${ALLOWED[action]} with the payment's version, a leased job and no audit row yet`, async () => {
      const paymentId = await paymentIn(ALLOWED[action], { version: 4 });
      const ctx = context();

      const { payment, operation, job } = reserved(
        await reserveAction(deps, ctx, { paymentId, action }),
      );

      expect(payment).toMatchObject({ id: paymentId, state: ALLOWED[action], version: 4 });
      expect(operation).toMatchObject({
        action,
        status: 'reserved',
        idempotencyScope: `${action}:${paymentId}`,
        expectedVersion: 4,
      });
      expect(job).toMatchObject({ status: 'running', leaseOwner: LEASE_OWNER, leaseGeneration: 1 });
      expect(await auditRowsOf(paymentId)).toBe(0);
    });

    it.each(PAYMENT_STATES.filter((state) => state !== ALLOWED[action]))(
      'refuses from %s with INVALID_STATE_TRANSITION and writes nothing',
      async (state) => {
        const paymentId = await paymentIn(state);

        await expect(reserveAction(deps, context(), { paymentId, action })).rejects.toBeInstanceOf(
          InvalidStateTransitionError,
        );
        expect(await operationsOn(paymentId)).toBe(0);
      },
    );

    it("treats another merchant's payment, a missing one and a malformed ID as not found", async () => {
      const others = await paymentIn(ALLOWED[action], { merchantId: bicycleId });

      for (const paymentId of [others, randomUUID(), 'not-a-uuid']) {
        await expect(reserveAction(deps, context(), { paymentId, action })).rejects.toBeInstanceOf(
          PaymentNotFoundError,
        );
      }
      expect(await operationsOn(others)).toBe(0);
    });

    it.each(['reserved', 'awaiting_confirmation', 'needs_review'])(
      'refuses a new key while an operation is %s',
      async (status) => {
        const paymentId = await paymentIn(ALLOWED[action]);
        const first = reserved(await reserveAction(deps, context(), { paymentId, action }));
        await pool.query('UPDATE operations SET status = $2 WHERE id = $1', [
          first.operation.id,
          status,
        ]);

        await expect(reserveAction(deps, context(), { paymentId, action })).rejects.toEqual(
          expect.objectContaining({
            code: 'OPERATION_IN_PROGRESS',
            operationId: first.operation.id,
          }),
        );
      },
    );

    it('lets one of ten concurrent requests with different keys through; the rest get OPERATION_IN_PROGRESS', async () => {
      const paymentId = await paymentIn(ALLOWED[action]);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => reserveAction(deps, context(), { paymentId, action })),
      );

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const refused = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      expect(fulfilled).toHaveLength(1);
      expect(refused).toHaveLength(9);
      for (const reason of refused) expect(reason).toBeInstanceOf(OperationInProgressError);
      expect(await operationsOn(paymentId)).toBe(1);
    });

    it('replays ten concurrent requests with one key', async () => {
      const paymentId = await paymentIn(ALLOWED[action]);
      const ctx = context();

      const results = await Promise.all(
        Array.from({ length: 10 }, () => reserveAction(deps, ctx, { paymentId, action })),
      );

      expect(results.filter((result) => result.kind === 'reserved')).toHaveLength(1);
      expect(new Set(results.map((result) => result.operation.id)).size).toBe(1);
    });

    it('replays before checking for unresolved work or the state', async () => {
      const paymentId = await paymentIn(ALLOWED[action]);
      const ctx = context();
      const first = reserved(await reserveAction(deps, ctx, { paymentId, action }));

      // Still unresolved: the same key is a replay, not OPERATION_IN_PROGRESS.
      expect(await reserveAction(deps, ctx, { paymentId, action })).toMatchObject({
        kind: 'replay',
        operation: { id: first.operation.id, status: 'reserved' },
      });

      // Finished and the payment moved on: the same key is still a replay, not INVALID_STATE_TRANSITION.
      await pool.query(
        `UPDATE operations SET status = 'succeeded', completed_at = now(), response_status = 200
          WHERE id = $1`,
        [first.operation.id],
      );
      await pool.query(`UPDATE payments SET state = $2 WHERE id = $1`, [
        paymentId,
        action === 'capture' ? 'captured' : 'refunded',
      ]);
      expect(await reserveAction(deps, ctx, { paymentId, action })).toMatchObject({
        kind: 'replay',
        operation: { id: first.operation.id, status: 'succeeded', responseStatus: 200 },
      });
    });

    it('replays a differently cased payment ID while unresolved and after rejection', async () => {
      const paymentId = await paymentIn(ALLOWED[action]);
      const ctx = context();
      const first = reserved(await reserveAction(deps, ctx, { paymentId, action }));

      for (const spelling of [paymentId.toUpperCase(), mixedCase(paymentId)]) {
        expect(await reserveAction(deps, ctx, { paymentId: spelling, action })).toMatchObject({
          kind: 'replay',
          operation: { id: first.operation.id, status: 'reserved' },
        });
      }

      await pool.query(
        `UPDATE operations
            SET status = 'rejected', reason = $2, response_status = 422, completed_at = now()
          WHERE id = $1`,
        [first.operation.id, `${action}_rejected`],
      );
      const replay = await reserveAction(deps, ctx, { paymentId: paymentId.toUpperCase(), action });

      expect(replay).toMatchObject({
        kind: 'replay',
        operation: { id: first.operation.id, status: 'rejected', responseStatus: 422 },
      });
      expect(replay.operation.providerKey).toBe(first.operation.providerKey);
      expect(await operationsOn(paymentId)).toBe(1);
    });

    it('scopes keys to the payment, so one key can act on two payments', async () => {
      const key = `shared-${randomUUID()}`;
      const one = await paymentIn(ALLOWED[action]);
      const two = await paymentIn(ALLOWED[action]);

      reserved(
        await reserveAction(deps, context({ idempotencyKey: key }), { paymentId: one, action }),
      );
      reserved(
        await reserveAction(deps, context({ idempotencyKey: key }), { paymentId: two, action }),
      );
    });
  });

  it('reports unresolved work before the state, as spec §2.7 orders them', async () => {
    // The create is still unresolved and the payment is pending, so capture is
    // wrong on both counts; the unresolved operation is what the caller hears.
    const created = reserved(await reserveCreate(deps, context(), createInput()));

    await expect(
      reserveAction(deps, context(), { paymentId: created.payment.id, action: 'capture' }),
    ).rejects.toEqual(
      expect.objectContaining({ code: 'OPERATION_IN_PROGRESS', operationId: created.operation.id }),
    );
  });

  it('never logs the payment-method token or the reference', () => {
    const text = JSON.stringify(logs);

    expect(text).not.toContain('pm_card_visa');
    expect(text).not.toContain('padded-ref');
  });
});
