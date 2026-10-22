import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { createPool } from '@payments/db';
import { createLogger, createMetricsRegistry } from '@payments/observability';
import {
  capturePayment,
  claimJobs,
  createPayment,
  finalizeOperation,
  type MutationContext,
  type MutationResponse,
  OperationInProgressError,
  type PaymentDeps,
  recoverOperation,
  type RecoveryDeps,
  refundPayment,
  reserveCreate,
  scheduleRecovery,
  WorkMismatchError,
} from '@payments/payments';
import {
  createFakeProvider,
  type FakeProvider,
  ProviderUnavailableError,
} from '@payments/provider';
import type { Pool } from 'pg';

import { recoveryHandler } from '../../apps/worker/src/handlers/recovery';
import { Heartbeat } from '../../apps/worker/src/heartbeat';
import { Worker } from '../../apps/worker/src/worker';
import { SEEDED_MERCHANTS } from '../helpers/api';
import { injectFault, wrapProvider } from '../helpers/provider';
import { createScratchDatabase } from '../helpers/test-db';

const RETRY_BASE_MS = 1_000;

interface Body {
  payment: { id: string; state: string };
  operation: { id: string; status: string; reason: string | null };
}

describe('operation recovery', () => {
  let scratch: { url: string; drop: () => Promise<void> };
  let pool: Pool;
  let provider: FakeProvider;
  let merchantId: string;
  let logs: Record<string, unknown>[];
  let api: PaymentDeps;
  let worker: RecoveryDeps;

  beforeAll(async () => {
    scratch = await createScratchDatabase({ seed: true });
    pool = createPool(scratch.url, { applicationName: 'recovery-test', max: 10 });
    provider = createFakeProvider(pool, { timeoutMs: 100, settlementDelayMs: 0 });
    const merchant = await pool.query<{ id: string }>('SELECT id FROM merchants WHERE email = $1', [
      SEEDED_MERCHANTS.acme.email,
    ]);
    merchantId = merchant.rows[0]?.id ?? '';
  });

  beforeEach(async () => {
    logs = [];
    // Recovery claims any due job: start each test with none left over.
    await pool.query(`UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
                       WHERE status IN ('queued', 'running')`);
    const logger = createLogger({
      service: 'worker',
      level: 'debug',
      destination: new Writable({
        write(chunk: Buffer, _encoding, done) {
          logs.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
          done();
        },
      }),
    });
    api = {
      pool,
      logger,
      provider,
      source: 'api',
      leaseOwner: 'api:test',
      leaseSeconds: 30,
      reviewDeadlineSeconds: 1_800,
      settlementPollMs: 5_000,
      recoveryDelayMs: 5_000,
    };
    worker = {
      pool,
      logger,
      provider,
      source: 'worker',
      leaseSeconds: 30,
      maxRetries: 3,
      retryBaseMs: RETRY_BASE_MS,
      reviewDeadlineSeconds: 1_800,
      settlementPollMs: 5_000,
      random: () => 0.5,
    };
  });

  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  const context = (key = `key-${randomUUID()}`): MutationContext => ({
    merchantId,
    idempotencyKey: key,
    requestId: `req-${randomUUID()}`,
    traceparent: null,
  });
  const order = (paymentMethod: string) => ({
    amount: 1500,
    reference: `recovery-${randomUUID()}`,
    paymentMethod,
  });
  const body = (response: MutationResponse) => response.body as Body;

  /** Makes the queued recovery job due now, claims it as the worker, and runs one attempt. */
  async function recoverNext(deps: RecoveryDeps = worker) {
    await pool.query(
      `UPDATE jobs SET due_at = now() WHERE status = 'queued' AND type = 'operation_recovery'`,
    );
    const [job] = await claimJobs(pool, {
      owner: 'worker:test',
      freeSlots: 1,
      leaseSeconds: 30,
      types: ['operation_recovery'],
    });
    if (!job) throw new Error('expected a due recovery job');
    return { outcome: await recoverOperation(deps, job, { generation: job.leaseGeneration }), job };
  }

  async function state(paymentId: string) {
    const rows = async (sql: string) => (await pool.query(sql, [paymentId])).rows as unknown;
    return {
      payment: (
        await pool.query('SELECT state, version, failure_reason FROM payments WHERE id = $1', [
          paymentId,
        ])
      ).rows[0] as unknown,
      operations: await rows(
        'SELECT action, status, reason FROM operations WHERE payment_id = $1 ORDER BY created_at',
      ),
      audit: await rows(
        'SELECT from_state, to_state, source FROM audit_events WHERE payment_id = $1 ORDER BY occurred_at, to_state',
      ),
      jobs: await rows(
        `SELECT type, status, consecutive_failures, paused_reason FROM jobs WHERE payment_id = $1 ORDER BY created_at`,
      ),
    };
  }

  const providerRequests = async (paymentId: string, kind: string) =>
    Number(
      (
        await pool.query<{ n: string }>(
          `SELECT count(*) AS n FROM provider.requests r JOIN operations o ON o.provider_key = r.provider_key
            WHERE o.payment_id = $1 AND r.kind = $2`,
          [paymentId, kind],
        )
      ).rows[0]?.n,
    );

  describe('pm_lost_response', () => {
    it('confirms a create the provider authorized but whose answer was lost, once', async () => {
      const ctx = context();
      const input = order('pm_lost_response');
      const first = await createPayment(api, ctx, input);
      const paymentId = body(first).payment.id;
      expect(first.status).toBe(202);

      expect((await recoverNext()).outcome).toBe('finalized');

      expect(await state(paymentId)).toMatchObject({
        payment: { state: 'authorized', version: 1 },
        operations: [{ action: 'authorize', status: 'succeeded' }],
        audit: [
          { from_state: null, to_state: 'pending', source: 'api' },
          { from_state: 'pending', to_state: 'authorized', source: 'worker' },
        ],
        jobs: [{ type: 'operation_recovery', status: 'completed' }],
      });
      expect(await providerRequests(paymentId, 'authorize')).toBe(1);
      // The client's retry with the same key now gets the saved 201, with no new call.
      const replay = await createPayment(api, ctx, input);
      expect(replay.status).toBe(201);
      expect(body(replay).payment.state).toBe('authorized');
    });

    it('confirms a lost capture and a lost refund, once each', async () => {
      const created = await createPayment(api, context(), order('pm_lost_response'));
      const paymentId = body(created).payment.id;
      await recoverNext();

      expect((await capturePayment(api, context(), { paymentId })).status).toBe(202);
      expect((await recoverNext()).outcome).toBe('finalized');
      await pool.query(
        `UPDATE payments SET state = 'settled', version = version + 1 WHERE id = $1`,
        [paymentId],
      );
      expect((await refundPayment(api, context(), { paymentId })).status).toBe(202);
      expect((await recoverNext()).outcome).toBe('finalized');

      const final = await state(paymentId);
      expect(final.payment).toMatchObject({ state: 'refunded' });
      expect(final.operations).toEqual([
        { action: 'authorize', status: 'succeeded', reason: null },
        { action: 'capture', status: 'succeeded', reason: null },
        { action: 'refund', status: 'succeeded', reason: null },
      ]);
      expect(
        (final.audit as { source: string; to_state: string }[]).map(
          (row) => `${row.to_state}:${row.source}`,
        ),
      ).toEqual(['pending:api', 'authorized:worker', 'captured:worker', 'refunded:worker']);
      expect(await providerRequests(paymentId, 'capture')).toBe(1);
      expect(await providerRequests(paymentId, 'refund')).toBe(1);
    });
  });

  describe('pm_timeout', () => {
    it('ends Failed with authorization_not_received, and a late original call is refused', async () => {
      const created = await createPayment(api, context(), order('pm_timeout'));
      const paymentId = body(created).payment.id;

      expect((await recoverNext()).outcome).toBe('finalized');

      expect(await state(paymentId)).toMatchObject({
        payment: { state: 'failed', failure_reason: 'authorization_not_received', version: 1 },
        operations: [
          { action: 'authorize', status: 'rejected', reason: 'authorization_not_received' },
        ],
        audit: [
          { from_state: null, to_state: 'pending' },
          { from_state: 'pending', to_state: 'failed', source: 'worker' },
        ],
      });
      const providerKey = (
        await pool.query<{ provider_key: string }>(
          'SELECT provider_key FROM operations WHERE payment_id = $1',
          [paymentId],
        )
      ).rows[0]?.provider_key;
      expect(
        await provider.authorize({
          providerKey: providerKey ?? '',
          token: 'pm_card_visa',
          amountCents: 1500,
        }),
      ).toEqual({ outcome: 'rejected', code: 'authorization_not_received' });
    });
  });

  describe('retry budget', () => {
    /** An authorized payment whose capture reached nobody: the API's call timed out before any effect. */
    async function captureThatNeverArrives(timeouts: number) {
      const created = await createPayment(api, context(), order('pm_card_visa'));
      const paymentId = body(created).payment.id;
      const charge = (
        await pool.query<{ provider_payment_id: string }>(
          'SELECT provider_payment_id FROM payments WHERE id = $1',
          [paymentId],
        )
      ).rows[0]?.provider_payment_id;
      for (let i = 0; i < timeouts; i += 1) {
        await injectFault(pool, {
          kind: 'capture',
          fault: 'timeout_before_effect',
          chargeId: charge ?? '',
        });
      }
      expect((await capturePayment(api, context(), { paymentId })).status).toBe(202);
      return paymentId;
    }

    it('pauses after three retries of "not received, re-send, timeout", with backoff between', async () => {
      const paymentId = await captureThatNeverArrives(5);

      const attempts: { outcome: string; delayMs: number | undefined }[] = [];
      for (let i = 0; i < 4; i += 1) {
        const { outcome } = await recoverNext();
        const due = (
          await pool.query<{ ms: number }>(
            `SELECT (extract(epoch FROM due_at - now()) * 1000)::float8 AS ms FROM jobs
              WHERE payment_id = $1 AND type = 'operation_recovery' AND status = 'queued'`,
            [paymentId],
          )
        ).rows[0]?.ms;
        attempts.push({
          outcome,
          delayMs: due === undefined ? undefined : Math.round(due / 100) * 100,
        });
      }

      // One first recovery attempt plus three retries, each lookup finding nothing and the re-send timing out.
      expect(attempts).toEqual([
        { outcome: 'retry_scheduled', delayMs: 1_000 },
        { outcome: 'retry_scheduled', delayMs: 2_000 },
        { outcome: 'retry_scheduled', delayMs: 4_000 },
        { outcome: 'paused', delayMs: undefined },
      ]);
      expect(await state(paymentId)).toMatchObject({
        payment: { state: 'authorized', version: 1 },
        operations: [
          { action: 'authorize', status: 'succeeded' },
          { action: 'capture', status: 'needs_review', reason: 'retries_exhausted' },
        ],
        jobs: [
          { type: 'operation_recovery', status: 'completed' },
          {
            type: 'operation_recovery',
            status: 'paused',
            consecutive_failures: 4,
            paused_reason: 'retries_exhausted',
          },
        ],
      });
      expect(await providerRequests(paymentId, 'capture')).toBe(0);
      expect(logs.filter((line) => line.event === 'job.retry_scheduled')).toHaveLength(3);
      expect(logs).toContainEqual(
        expect.objectContaining({
          event: 'job.paused',
          reason: 'retries_exhausted',
          level: 'error',
        }),
      );
    });

    it('keeps the paused operation blocking new mutations with OPERATION_IN_PROGRESS', async () => {
      const paymentId = await captureThatNeverArrives(5);
      for (let i = 0; i < 4; i += 1) await recoverNext();

      await expect(capturePayment(api, context(), { paymentId })).rejects.toBeInstanceOf(
        OperationInProgressError,
      );
      // Polling skips paused work.
      await pool.query(
        `UPDATE jobs SET due_at = now() - interval '1 hour' WHERE status = 'paused'`,
      );
      expect(
        await claimJobs(pool, {
          owner: 'worker:test',
          freeSlots: 5,
          leaseSeconds: 30,
          types: ['operation_recovery'],
        }),
      ).toEqual([]);
    });

    it('finalizes on the next attempt after a failed one, with one capture effect', async () => {
      const paymentId = await captureThatNeverArrives(2);

      expect((await recoverNext()).outcome).toBe('retry_scheduled');
      expect((await recoverNext()).outcome).toBe('finalized');

      expect((await state(paymentId)).payment).toMatchObject({ state: 'captured' });
      expect(await providerRequests(paymentId, 'capture')).toBe(1);
    });

    it('counts an unreachable provider on the lookup as a failed attempt', async () => {
      const created = await createPayment(api, context(), order('pm_timeout'));
      const unreachable = {
        ...worker,
        provider: wrapProvider(provider, {
          lookup: () =>
            Promise.reject(new ProviderUnavailableError(new Error('connection refused'))),
        }),
      };

      expect((await recoverNext(unreachable)).outcome).toBe('retry_scheduled');

      expect(await state(body(created).payment.id)).toMatchObject({
        operations: [{ status: 'awaiting_confirmation', reason: 'provider_unavailable' }],
        jobs: [{ status: 'queued', consecutive_failures: 1 }],
      });
    });

    it('pauses at the review deadline without calling the provider', async () => {
      const created = await createPayment(api, context(), order('pm_timeout'));
      const paymentId = body(created).payment.id;
      await pool.query(
        `UPDATE jobs SET review_deadline = now() - interval '1 second' WHERE payment_id = $1`,
        [paymentId],
      );
      let lookups = 0;
      const counting = {
        ...worker,
        provider: wrapProvider(provider, {
          lookup: (req) => {
            lookups += 1;
            return provider.lookup(req);
          },
        }),
      };

      expect((await recoverNext(counting)).outcome).toBe('paused');

      expect(lookups).toBe(0);
      expect(await state(paymentId)).toMatchObject({
        payment: { state: 'pending' },
        operations: [{ status: 'needs_review', reason: 'review_deadline_reached' }],
        jobs: [{ status: 'paused', paused_reason: 'review_deadline_reached' }],
      });
    });

    it('stops before calling the provider once another owner has taken the job', async () => {
      await createPayment(api, context(), order('pm_timeout'));
      await pool.query(`UPDATE jobs SET due_at = now() WHERE status = 'queued'`);
      const [job] = await claimJobs(pool, {
        owner: 'worker:A',
        freeSlots: 1,
        leaseSeconds: 30,
        types: ['operation_recovery'],
      });
      if (!job) throw new Error('expected a claim');
      // Another worker takes it over (generation + 1) before A starts its attempt.
      await pool.query('UPDATE jobs SET lease_generation = lease_generation + 1 WHERE id = $1', [
        job.id,
      ]);
      let lookups = 0;
      const counting = {
        ...worker,
        provider: wrapProvider(provider, {
          lookup: (req) => {
            lookups += 1;
            return provider.lookup(req);
          },
        }),
      };

      expect(await recoverOperation(counting, job, { generation: job.leaseGeneration })).toBe(
        'lease_lost',
      );
      expect(lookups).toBe(0);
    });
  });

  describe('mismatched work', () => {
    /**
     * Two unresolved creates, A and B, each with its recovery job claimed at
     * the same lease generation, so only the identity checks can tell them apart.
     */
    async function twoClaimedOperations() {
      const ids = [];
      for (let i = 0; i < 2; i += 1) {
        ids.push(body(await createPayment(api, context(), order('pm_timeout'))).payment.id);
      }
      await pool.query(`UPDATE jobs SET due_at = now() WHERE status = 'queued'`);
      const claimed = await claimJobs(pool, {
        owner: 'worker:test',
        freeSlots: 2,
        leaseSeconds: 30,
        types: ['operation_recovery'],
      });
      const jobOf = (paymentId: string | undefined) => {
        const job = claimed.find((candidate) => candidate.paymentId === paymentId);
        if (!job?.operationId) throw new Error('expected a claimed recovery job');
        return { ...job, operationId: job.operationId };
      };
      const a = jobOf(ids[0]);
      const b = jobOf(ids[1]);
      expect(a.leaseGeneration).toBe(b.leaseGeneration);
      return { a, b };
    }

    /** Every provider call, counted. */
    function countingDeps() {
      const calls: string[] = [];
      const deps = {
        ...worker,
        provider: wrapProvider(provider, {
          authorize: (req) => {
            calls.push('authorize');
            return provider.authorize(req);
          },
          capture: (req) => {
            calls.push('capture');
            return provider.capture(req);
          },
          refund: (req) => {
            calls.push('refund');
            return provider.refund(req);
          },
          lookup: (req) => {
            calls.push('lookup');
            return provider.lookup(req);
          },
        }),
      };
      return { deps, calls };
    }

    /** Every column of both payments, their operations and jobs, plus audit and provider rows. */
    async function everything(paymentIds: string[]) {
      const all = async (sql: string) => (await pool.query(sql, [paymentIds])).rows as unknown;
      return {
        payments: await all('SELECT * FROM payments WHERE id = ANY($1) ORDER BY id'),
        operations: await all('SELECT * FROM operations WHERE payment_id = ANY($1) ORDER BY id'),
        jobs: await all('SELECT * FROM jobs WHERE payment_id = ANY($1) ORDER BY id'),
        audit: await all('SELECT * FROM audit_events WHERE payment_id = ANY($1) ORDER BY id'),
        providerRequests: Number(
          (await pool.query<{ n: string }>('SELECT count(*) AS n FROM provider.requests')).rows[0]
            ?.n,
        ),
      };
    }

    it("refuses job A's record carrying job B's ID, before any call or write", async () => {
      const { a, b } = await twoClaimedOperations();
      const { deps, calls } = countingDeps();
      const before = await everything([a.paymentId, b.paymentId]);

      await expect(
        recoverOperation(deps, { ...a, id: b.id }, { generation: a.leaseGeneration }),
      ).rejects.toBeInstanceOf(WorkMismatchError);

      expect(calls).toEqual([]);
      expect(await everything([a.paymentId, b.paymentId])).toEqual(before);
    });

    it("refuses a job row that points at the other payment's operation", async () => {
      const { a, b } = await twoClaimedOperations();
      // Job A's row now names operation B while still naming payment A.
      await pool.query('UPDATE jobs SET operation_id = $2 WHERE id = $1', [a.id, b.operationId]);
      const { deps, calls } = countingDeps();
      const before = await everything([a.paymentId, b.paymentId]);

      await expect(
        recoverOperation(
          deps,
          { ...a, operationId: b.operationId },
          { generation: a.leaseGeneration },
        ),
      ).rejects.toBeInstanceOf(WorkMismatchError);

      expect(calls).toEqual([]);
      expect(await everything([a.paymentId, b.paymentId])).toEqual(before);
    });

    it('refuses to finalize operation A through job B, even at a matching generation', async () => {
      const { a, b } = await twoClaimedOperations();
      const before = await everything([a.paymentId, b.paymentId]);

      await expect(
        finalizeOperation(
          worker,
          {
            paymentId: a.paymentId,
            operationId: a.operationId,
            jobId: b.id,
            generation: b.leaseGeneration,
          },
          { outcome: 'not_received' },
        ),
      ).rejects.toBeInstanceOf(WorkMismatchError);

      expect(await everything([a.paymentId, b.paymentId])).toEqual(before);
    });

    it('refuses to reschedule or retry operation A through job B', async () => {
      const { a, b } = await twoClaimedOperations();
      const before = await everything([a.paymentId, b.paymentId]);

      await expect(
        scheduleRecovery(
          worker,
          {
            paymentId: a.paymentId,
            operationId: a.operationId,
            jobId: b.id,
            generation: b.leaseGeneration,
          },
          { reason: 'provider_timeout', delayMs: 1_000 },
        ),
      ).rejects.toBeInstanceOf(WorkMismatchError);

      expect(await everything([a.paymentId, b.paymentId])).toEqual(before);
    });

    it('refuses to finalize when the payment named is not the operation’s', async () => {
      const { a, b } = await twoClaimedOperations();
      const before = await everything([a.paymentId, b.paymentId]);

      await expect(
        finalizeOperation(
          worker,
          {
            paymentId: b.paymentId,
            operationId: a.operationId,
            jobId: a.id,
            generation: a.leaseGeneration,
          },
          { outcome: 'not_received' },
        ),
      ).rejects.toBeInstanceOf(WorkMismatchError);

      expect(await everything([a.paymentId, b.paymentId])).toEqual(before);
    });

    it.each([
      ['an operation that does not exist', 'operation'],
      ['a payment that does not exist', 'payment'],
    ] as const)('refuses to finalize or reschedule %s', async (_label, missing) => {
      const { a, b } = await twoClaimedOperations();
      const before = await everything([a.paymentId, b.paymentId]);
      const work = {
        paymentId: missing === 'payment' ? randomUUID() : a.paymentId,
        operationId: missing === 'operation' ? randomUUID() : a.operationId,
        jobId: a.id,
        generation: a.leaseGeneration,
      };

      await expect(
        finalizeOperation(worker, work, { outcome: 'not_received' }),
      ).rejects.toBeInstanceOf(WorkMismatchError);
      await expect(
        scheduleRecovery(worker, work, { reason: 'provider_timeout', delayMs: 1_000 }),
      ).rejects.toBeInstanceOf(WorkMismatchError);

      expect(await everything([a.paymentId, b.paymentId])).toEqual(before);
    });

    it('refuses a settlement job handed to operation recovery', async () => {
      const { a } = await twoClaimedOperations();
      const { deps, calls } = countingDeps();
      const before = await everything([a.paymentId]);

      await expect(
        recoverOperation(deps, { ...a, type: 'settlement' }, { generation: a.leaseGeneration }),
      ).rejects.toBeInstanceOf(WorkMismatchError);

      expect(calls).toEqual([]);
      expect(await everything([a.paymentId])).toEqual(before);
    });
  });

  describe('crash after the provider effect, before the local commit', () => {
    it('recovers exactly once when the worker runs: one effect, one finalization, one audit row per transition', async () => {
      // Core crash test (design §6.1): reserve and call the provider, then "crash" before finalizing.
      const ctx = context();
      const input = order('pm_card_visa');
      const reservation = await reserveCreate(api, ctx, input);
      if (reservation.kind !== 'reserved') throw new Error('expected a reservation');
      const { payment, operation, job } = reservation;
      const effect = await provider.authorize({
        providerKey: operation.providerKey,
        token: input.paymentMethod,
        amountCents: input.amount,
      });
      expect(effect.outcome).toBe('succeeded');
      // The API process is gone: no finalize ever runs. Its lease runs out.
      await pool.query(
        `UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [job.id],
      );

      const heartbeat = new Heartbeat(createMetricsRegistry('worker'), 1_000);
      const loop = new Worker({
        pool,
        logger: worker.logger,
        owner: 'worker:recovery',
        concurrency: 1,
        pollIntervalMs: 50,
        leaseSeconds: 30,
        heartbeat,
        handlers: { operation_recovery: recoveryHandler(worker) },
      });
      loop.start();
      try {
        for (let i = 0; i < 100; i += 1) {
          const row = await pool.query<{ status: string }>(
            'SELECT status FROM jobs WHERE id = $1',
            [job.id],
          );
          if (row.rows[0]?.status === 'completed') break;
          await sleep(20);
        }
      } finally {
        await loop.stop(1_000);
      }

      expect(await state(payment.id)).toEqual({
        payment: { state: 'authorized', version: 1, failure_reason: null },
        operations: [{ action: 'authorize', status: 'succeeded', reason: null }],
        audit: [
          { from_state: null, to_state: 'pending', source: 'api' },
          { from_state: 'pending', to_state: 'authorized', source: 'worker' },
        ],
        jobs: [
          {
            type: 'operation_recovery',
            status: 'completed',
            consecutive_failures: 0,
            paused_reason: null,
          },
        ],
      });
      expect(await providerRequests(payment.id, 'authorize')).toBe(1);
      expect(logs.filter((line) => line.event === 'payment.transitioned')).toHaveLength(1);
      // The client retrying after the crash gets the recovered result, not a second charge.
      const replay = await createPayment(api, ctx, input);
      expect(replay.status).toBe(201);
      expect(body(replay).payment.state).toBe('authorized');
      expect(await providerRequests(payment.id, 'authorize')).toBe(1);
    });
  });

  it('never logs payment-method tokens', () => {
    expect(JSON.stringify(logs)).not.toMatch(/pm_(card|timeout|lost)/);
  });
});
