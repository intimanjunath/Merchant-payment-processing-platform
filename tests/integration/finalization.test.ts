import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { createPool } from '@payments/db';
import { createLogger } from '@payments/observability';
import {
  capturePayment,
  createPayment,
  finalizeOperation,
  type MutationContext,
  type MutationResponse,
  OperationInProgressError,
  type PaymentDeps,
  refundPayment,
  reserveAction,
  scheduleRecovery,
  type WorkRef,
} from '@payments/payments';
import { createFakeProvider, type PaymentProvider } from '@payments/provider';
import type { Pool } from 'pg';

import { migrateTestDatabase, SEEDED_MERCHANTS } from '../helpers/api';
import { clearInjectedFaults, injectFault, wrapProvider } from '../helpers/provider';
import { testDatabaseUrl } from '../helpers/test-db';

const RECOVERY_DELAY_MS = 5_000;
const SETTLEMENT_POLL_MS = 5_000;
const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

interface Body {
  payment: { id: string; state: string; failureReason: string | null };
  operation: { id: string; status: string; reason: string | null };
}

describe('finalization', () => {
  let pool: Pool;
  let deps: PaymentDeps;
  let merchantId: string;
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    await migrateTestDatabase({ seed: true });
    pool = createPool(testDatabaseUrl(), { applicationName: 'finalization-test', max: 20 });
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
      source: 'api',
      leaseOwner: 'api:test',
      leaseSeconds: 30,
      reviewDeadlineSeconds: 1_800,
      settlementPollMs: SETTLEMENT_POLL_MS,
      recoveryDelayMs: RECOVERY_DELAY_MS,
    };
    const merchant = await pool.query<{ id: string }>('SELECT id FROM merchants WHERE email = $1', [
      SEEDED_MERCHANTS.acme.email,
    ]);
    merchantId = merchant.rows[0]?.id ?? '';
  });

  beforeEach(async () => {
    await clearInjectedFaults(pool);
  });

  afterAll(async () => {
    await clearInjectedFaults(pool);
    await pool.end();
  });

  const context = (): MutationContext => ({
    merchantId,
    idempotencyKey: `key-${randomUUID()}`,
    requestId: `req-${randomUUID()}`,
    traceparent: TRACEPARENT,
  });
  const createInput = (paymentMethod = 'pm_card_visa') => ({
    amount: 1500,
    reference: `order-${randomUUID()}`,
    paymentMethod,
  });
  const body = (response: MutationResponse) => response.body as Body;

  const auditTrail = async (paymentId: string) =>
    (
      await pool.query<{
        from_state: string | null;
        to_state: string;
        source: string;
        reason: string;
      }>(
        `SELECT from_state, to_state, source, reason FROM audit_events
          WHERE payment_id = $1 ORDER BY occurred_at, to_state`,
        [paymentId],
      )
    ).rows;
  const paymentRow = async (paymentId: string) =>
    (
      await pool.query<{
        state: string;
        version: number;
        failure_reason: string | null;
        provider_payment_id: string | null;
      }>('SELECT state, version, failure_reason, provider_payment_id FROM payments WHERE id = $1', [
        paymentId,
      ])
    ).rows[0];
  const jobsOf = async (paymentId: string) =>
    (
      await pool.query<{
        type: string;
        work_key: string;
        status: string;
        lease_owner: string | null;
        lease_generation: string;
        due_in_ms: number;
        request_id: string;
        traceparent: string | null;
        last_error: string | null;
      }>(
        `SELECT type, work_key, status, lease_owner, lease_generation, request_id, traceparent, last_error,
                (extract(epoch FROM due_at - now()) * 1000)::float8 AS due_in_ms
           FROM jobs WHERE payment_id = $1 ORDER BY created_at`,
        [paymentId],
      )
    ).rows;
  const providerRequestsFor = async (chargeId: string, kind: string) =>
    Number(
      (
        await pool.query<{ n: string }>(
          'SELECT count(*) AS n FROM provider.requests WHERE charge_id = $1 AND kind = $2',
          [chargeId, kind],
        )
      ).rows[0]?.n,
    );

  async function authorizedPayment(): Promise<string> {
    const response = await createPayment(deps, context(), createInput());
    return body(response).payment.id;
  }

  /** Authorized, captured, then marked settled as the settlement worker (step 14) will. */
  async function settledPayment(): Promise<string> {
    const paymentId = await authorizedPayment();
    await capturePayment(deps, context(), { paymentId });
    await pool.query(`UPDATE payments SET state = 'settled', version = version + 1 WHERE id = $1`, [
      paymentId,
    ]);
    return paymentId;
  }

  describe('create', () => {
    it('authorizes: 201, version 1, two audit rows, job completed, response saved', async () => {
      const response = await createPayment(deps, context(), createInput());
      const { payment, operation } = body(response);

      expect(response.status).toBe(201);
      expect(payment.state).toBe('authorized');
      expect(operation).toMatchObject({ status: 'succeeded', reason: null });
      expect(await paymentRow(payment.id)).toMatchObject({
        state: 'authorized',
        version: 1,
        failure_reason: null,
        provider_payment_id: expect.stringMatching(/^ch_/),
      });
      expect(await auditTrail(payment.id)).toEqual([
        { from_state: null, to_state: 'pending', source: 'api', reason: 'create_accepted' },
        {
          from_state: 'pending',
          to_state: 'authorized',
          source: 'api',
          reason: 'authorization_confirmed',
        },
      ]);
      expect(await jobsOf(payment.id)).toEqual([
        expect.objectContaining({
          type: 'operation_recovery',
          status: 'completed',
          lease_owner: null,
        }),
      ]);
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: 'payment.transitioned',
          paymentId: payment.id,
          fromState: 'pending',
          toState: 'authorized',
        }),
      );
    });

    it('replays the saved response without calling the provider again', async () => {
      const ctx = context();
      const input = createInput();
      const first = await createPayment(deps, ctx, input);
      const chargeId = (await paymentRow(body(first).payment.id))?.provider_payment_id ?? '';

      const again = await createPayment(deps, ctx, input);

      expect(again).toEqual(first);
      expect(await providerRequestsFor(chargeId, 'authorize')).toBe(1);
    });

    it('commits a decline as Failed with card_declined and two audit rows, still 201', async () => {
      const ctx = context();
      const input = createInput('pm_card_declined');
      const response = await createPayment(deps, ctx, input);
      const { payment, operation } = body(response);

      expect(response.status).toBe(201);
      expect(payment).toMatchObject({ state: 'failed', failureReason: 'card_declined' });
      expect(operation).toMatchObject({ status: 'rejected', reason: 'card_declined' });
      expect(await auditTrail(payment.id)).toEqual([
        expect.objectContaining({ from_state: null, to_state: 'pending' }),
        {
          from_state: 'pending',
          to_state: 'failed',
          source: 'api',
          reason: 'authorization_failed',
        },
      ]);
      expect(await createPayment(deps, ctx, input)).toEqual(response);
    });

    it('answers 202 after a timeout and hands the job back for recovery', async () => {
      const ctx = context();
      const input = createInput('pm_timeout');
      const response = await createPayment(deps, ctx, input);
      const { payment, operation } = body(response);

      expect(response.status).toBe(202);
      expect(payment.state).toBe('pending');
      expect(operation).toMatchObject({
        status: 'awaiting_confirmation',
        reason: 'provider_timeout',
      });
      const [job] = await jobsOf(payment.id);
      expect(job).toMatchObject({
        status: 'queued',
        lease_owner: null,
        lease_generation: '1',
        last_error: 'provider_timeout',
      });
      expect(job?.due_in_ms).toBeGreaterThan(RECOVERY_DELAY_MS - 1_000);
      expect(job?.due_in_ms).toBeLessThanOrEqual(RECOVERY_DELAY_MS);
      expect(await auditTrail(payment.id)).toHaveLength(1);
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: 'operation.awaiting_confirmation',
          operationId: operation.id,
        }),
      );

      // Still unresolved: a retry with the key answers 202 again, without a new call.
      expect((await createPayment(deps, ctx, input)).status).toBe(202);
    });

    it('answers 202 for a lost response, though the provider kept the charge', async () => {
      const response = await createPayment(deps, context(), createInput('pm_lost_response'));

      expect(response.status).toBe(202);
      expect(body(response).operation.reason).toBe('provider_timeout');
      expect(await paymentRow(body(response).payment.id)).toMatchObject({
        state: 'pending',
        version: 0,
      });
    });

    it('answers 202 with provider_unavailable when the provider cannot be reached', async () => {
      const closed = createPool(testDatabaseUrl(), { applicationName: 'unreachable', max: 1 });
      await closed.end();
      const unreachable = {
        ...deps,
        provider: createFakeProvider(closed, { timeoutMs: 100, settlementDelayMs: 0 }),
      };

      const response = await createPayment(unreachable, context(), createInput());

      expect(response.status).toBe(202);
      expect(body(response).operation).toMatchObject({
        status: 'awaiting_confirmation',
        reason: 'provider_unavailable',
      });
    });
  });

  describe('capture', () => {
    it('captures: 200, three audit rows, and settlement scheduled with the capture’s correlation', async () => {
      const paymentId = await authorizedPayment();
      const ctx = context();

      const response = await capturePayment(deps, ctx, { paymentId });

      expect(response.status).toBe(200);
      expect(body(response)).toMatchObject({
        payment: { state: 'captured' },
        operation: { status: 'succeeded' },
      });
      expect((await auditTrail(paymentId)).map((row) => row.to_state)).toEqual([
        'pending',
        'authorized',
        'captured',
      ]);
      const jobs = await jobsOf(paymentId);
      expect(jobs.map((job) => [job.type, job.status])).toEqual([
        ['operation_recovery', 'completed'],
        ['operation_recovery', 'completed'],
        ['settlement', 'queued'],
      ]);
      const settlement = jobs[2];
      expect(settlement).toMatchObject({
        work_key: `settle:${paymentId}`,
        request_id: ctx.requestId,
        traceparent: ctx.traceparent,
      });
      expect(settlement?.due_in_ms).toBeGreaterThan(SETTLEMENT_POLL_MS - 1_000);
    });

    it('keeps the payment Authorized on a provider rejection: 422, two audit rows, saved for replay', async () => {
      const paymentId = await authorizedPayment();
      const chargeId = (await paymentRow(paymentId))?.provider_payment_id ?? '';
      await injectFault(pool, { kind: 'capture', fault: 'reject', chargeId });
      const ctx = context();

      const response = await capturePayment(deps, ctx, { paymentId });

      expect(response.status).toBe(422);
      const operationId = (
        await pool.query<{ id: string }>(
          `SELECT id FROM operations WHERE payment_id = $1 AND action = 'capture'`,
          [paymentId],
        )
      ).rows[0]?.id;
      expect(response.body).toEqual({
        error: {
          code: 'PROVIDER_REJECTED',
          message: 'The payment provider rejected the request.',
          details: { paymentId, operationId, code: 'rejected_by_provider' },
        },
      });
      expect(await paymentRow(paymentId)).toMatchObject({ state: 'authorized', version: 1 });
      expect(await auditTrail(paymentId)).toHaveLength(2);
      const operation = await pool.query(
        'SELECT status, reason, response_status FROM operations WHERE id = $1',
        [operationId],
      );
      expect(operation.rows[0]).toEqual({
        status: 'rejected',
        reason: 'capture_rejected',
        response_status: 422,
      });
      expect((await jobsOf(paymentId)).map((job) => job.type)).not.toContain('settlement');
      expect(await capturePayment(deps, ctx, { paymentId })).toEqual(response);
    });

    it('lets one of five concurrent captures with different keys reach the provider; the rest get 409', async () => {
      const paymentId = await authorizedPayment();
      const chargeId = (await paymentRow(paymentId))?.provider_payment_id ?? '';

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () => capturePayment(deps, context(), { paymentId })),
      );

      const answered = results.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.status] : [],
      );
      const refused = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : [],
      );
      expect(answered).toEqual([200]);
      expect(refused).toHaveLength(4);
      for (const reason of refused) expect(reason).toBeInstanceOf(OperationInProgressError);
      expect(await providerRequestsFor(chargeId, 'capture')).toBe(1);
    });
  });

  describe('refund', () => {
    it('refunds a settled payment: 200 and a refunded audit row', async () => {
      const paymentId = await settledPayment();

      const response = await refundPayment(deps, context(), { paymentId });

      expect(response.status).toBe(200);
      expect(body(response).payment.state).toBe('refunded');
      expect((await auditTrail(paymentId)).at(-1)).toEqual({
        from_state: 'settled',
        to_state: 'refunded',
        source: 'api',
        reason: 'refund_confirmed',
      });
    });

    it('keeps the payment Settled on a provider rejection', async () => {
      const paymentId = await settledPayment();
      const before = await paymentRow(paymentId);
      await injectFault(pool, { kind: 'refund', fault: 'reject' });

      const response = await refundPayment(deps, context(), { paymentId });

      expect(response.status).toBe(422);
      expect(await paymentRow(paymentId)).toEqual(before);
    });
  });

  describe('guards', () => {
    /** A capture reserved but not yet finalized, as if the provider call were in flight. */
    async function reservedCapture(): Promise<WorkRef & { chargeId: string }> {
      const paymentId = await authorizedPayment();
      const reservation = await reserveAction(deps, context(), { paymentId, action: 'capture' });
      if (reservation.kind !== 'reserved') throw new Error('expected a reservation');
      return {
        paymentId,
        operationId: reservation.operation.id,
        jobId: reservation.job.id,
        generation: reservation.job.leaseGeneration,
        chargeId: reservation.payment.providerPaymentId ?? '',
      };
    }

    const snapshot = async (work: WorkRef) => ({
      payment: await paymentRow(work.paymentId),
      operation: (
        await pool.query('SELECT status, reason, response_status FROM operations WHERE id = $1', [
          work.operationId,
        ])
      ).rows[0] as unknown,
      jobs: (
        await pool.query(
          `SELECT id, type, status, due_at, lease_owner, lease_expires_at, lease_generation, last_error
             FROM jobs WHERE payment_id = $1 ORDER BY created_at`,
          [work.paymentId],
        )
      ).rows as unknown,
      audit: await auditTrail(work.paymentId),
    });

    it('finalizes nothing when the payment version no longer matches', async () => {
      const work = await reservedCapture();
      await pool.query('UPDATE payments SET version = version + 1 WHERE id = $1', [work.paymentId]);
      const before = await snapshot(work);

      const result = await finalizeOperation(deps, work, {
        outcome: 'succeeded',
        chargeId: work.chargeId,
      });

      expect(result).toEqual({ kind: 'version_conflict' });
      expect(await snapshot(work)).toEqual(before);
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: 'operation.version_conflict',
          operationId: work.operationId,
        }),
      );
    });

    it('finalizes nothing for a rejection either when the version no longer matches', async () => {
      const work = await reservedCapture();
      await pool.query('UPDATE payments SET version = version + 1 WHERE id = $1', [work.paymentId]);
      const before = await snapshot(work);

      expect(
        await finalizeOperation(deps, work, { outcome: 'rejected', code: 'rejected_by_provider' }),
      ).toEqual({ kind: 'version_conflict' });
      expect(await snapshot(work)).toEqual(before);
    });

    it('finalizes and reschedules nothing once another owner holds a newer lease generation', async () => {
      const work = await reservedCapture();
      await pool.query('UPDATE jobs SET lease_generation = 2 WHERE id = $1', [work.jobId]);
      const before = await snapshot(work);

      expect(
        await finalizeOperation(deps, work, { outcome: 'succeeded', chargeId: work.chargeId }),
      ).toEqual({
        kind: 'lease_lost',
      });
      expect(
        await scheduleRecovery(deps, work, {
          reason: 'provider_timeout',
          delayMs: RECOVERY_DELAY_MS,
        }),
      ).toEqual({ kind: 'lease_lost' });
      expect(await snapshot(work)).toEqual(before);
      expect(logs).toContainEqual(
        expect.objectContaining({ event: 'job.lease_lost', jobId: work.jobId, generation: 1 }),
      );
    });

    it('finalizes once: a second finalization changes nothing', async () => {
      const work = await reservedCapture();
      const outcome = { outcome: 'succeeded', chargeId: work.chargeId } as const;
      expect((await finalizeOperation(deps, work, outcome)).kind).toBe('finalized');
      const after = await snapshot(work);

      expect(await finalizeOperation(deps, work, outcome)).toEqual({ kind: 'already_final' });
      expect(await snapshot(work)).toEqual(after);
      expect(after.audit).toHaveLength(3);
    });

    it('refuses "not received" as a final capture outcome and writes nothing', async () => {
      const work = await reservedCapture();
      const before = await snapshot(work);

      await expect(finalizeOperation(deps, work, { outcome: 'not_received' })).rejects.toThrow(
        '"not received" does not finalize a capture',
      );
      expect(await snapshot(work)).toEqual(before);
    });
  });

  describe('no locks during the provider call', () => {
    /**
     * Wraps the provider so each call first tries to lock the payment, the
     * operation and the job from another connection with NOWAIT. If the
     * caller held any of those locks, PostgreSQL would refuse at once (55P03).
     */
    function lockProbingProvider(inner: PaymentProvider, probes: string[]): PaymentProvider {
      const probe = async (providerKey: string) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const operation = await client.query<{ id: string; payment_id: string }>(
            'SELECT id, payment_id FROM operations WHERE provider_key = $1 FOR UPDATE NOWAIT',
            [providerKey],
          );
          const row = operation.rows[0];
          if (!row) throw new Error('operation not committed before the provider call');
          await client.query('SELECT 1 FROM payments WHERE id = $1 FOR UPDATE NOWAIT', [
            row.payment_id,
          ]);
          await client.query('SELECT 1 FROM jobs WHERE operation_id = $1 FOR UPDATE NOWAIT', [
            row.id,
          ]);
          probes.push('unlocked');
        } finally {
          await client.query('ROLLBACK');
          client.release();
        }
      };
      return wrapProvider(inner, {
        authorize: async (req) => {
          await probe(req.providerKey);
          return inner.authorize(req);
        },
        capture: async (req) => {
          await probe(req.providerKey);
          return inner.capture(req);
        },
        refund: async (req) => {
          await probe(req.providerKey);
          return inner.refund(req);
        },
      });
    }

    it('holds no lock on the payment, operation or job while the provider is called', async () => {
      const probes: string[] = [];
      const probing = { ...deps, provider: lockProbingProvider(deps.provider, probes) };

      const created = await createPayment(probing, context(), createInput());
      const paymentId = body(created).payment.id;
      await capturePayment(probing, context(), { paymentId });
      await pool.query(
        `UPDATE payments SET state = 'settled', version = version + 1 WHERE id = $1`,
        [paymentId],
      );
      const refunded = await refundPayment(probing, context(), { paymentId });

      expect(probes).toEqual(['unlocked', 'unlocked', 'unlocked']);
      expect(refunded.status).toBe(200);
    });
  });

  it('never logs the payment-method token', () => {
    expect(JSON.stringify(logs)).not.toMatch(/pm_(card|timeout|lost)/);
  });
});
