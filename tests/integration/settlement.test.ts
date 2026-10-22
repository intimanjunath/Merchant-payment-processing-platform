import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { createPool, type JobRecord } from '@payments/db';
import { createLogger, createMetricsRegistry } from '@payments/observability';
import {
  capturePayment,
  claimJobs,
  createPayment,
  type MutationContext,
  type PaymentDeps,
  type SettlementDeps,
  settlePayment,
  WorkMismatchError,
} from '@payments/payments';
import {
  createFakeProvider,
  type PaymentProvider,
  ProviderUnavailableError,
} from '@payments/provider';
import type { Pool } from 'pg';

import { settlementHandler } from '../../apps/worker/src/handlers/settlement';
import { Heartbeat } from '../../apps/worker/src/heartbeat';
import { Worker } from '../../apps/worker/src/worker';
import { SEEDED_MERCHANTS } from '../helpers/api';
import { wrapProvider } from '../helpers/provider';
import { createScratchDatabase } from '../helpers/test-db';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const CAPTURE_TRACEPARENT = `00-${TRACE_ID}-b7ad6b7169203331-01`;

describe('settlement', () => {
  let scratch: { url: string; drop: () => Promise<void> };
  let pool: Pool;
  let merchantId: string;
  let logs: Record<string, unknown>[];

  beforeAll(async () => {
    scratch = await createScratchDatabase({ seed: true });
    pool = createPool(scratch.url, { applicationName: 'settlement-test', max: 10 });
    const merchant = await pool.query<{ id: string }>('SELECT id FROM merchants WHERE email = $1', [
      SEEDED_MERCHANTS.acme.email,
    ]);
    merchantId = merchant.rows[0]?.id ?? '';
  });

  beforeEach(async () => {
    logs = [];
    await pool.query(`UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
                       WHERE status IN ('queued', 'running')`);
  });

  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  const logger = () =>
    createLogger({
      service: 'worker',
      level: 'debug',
      destination: new Writable({
        write(chunk: Buffer, _encoding, done) {
          logs.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
          done();
        },
      }),
    });

  /** Funds become available `settlementDelayMs` after capture. */
  const providerWith = (settlementDelayMs: number) =>
    createFakeProvider(pool, { timeoutMs: 100, settlementDelayMs });

  function apiDeps(provider: PaymentProvider, settlementPollMs = 1_000): PaymentDeps {
    return {
      pool,
      logger: logger(),
      provider,
      source: 'api',
      leaseOwner: 'api:test',
      leaseSeconds: 30,
      reviewDeadlineSeconds: 1_800,
      settlementPollMs,
      recoveryDelayMs: 5_000,
    };
  }

  function settlementDeps(
    provider: Pick<PaymentProvider, 'getSettlement'>,
    pollIntervalMs = 1_000,
  ): SettlementDeps {
    return {
      pool,
      logger: logger(),
      provider,
      leaseSeconds: 30,
      pollIntervalMs,
      maxRetries: 3,
      retryBaseMs: 1_000,
      random: () => 0.5,
    };
  }

  const context = (requestId = `req-${randomUUID()}`): MutationContext => ({
    merchantId,
    idempotencyKey: `key-${randomUUID()}`,
    requestId,
    traceparent: CAPTURE_TRACEPARENT,
  });

  /** An authorized then captured payment; its settlement job inherits the capture's correlation. */
  async function captured(
    provider: PaymentProvider,
    captureRequestId = `req-capture-${randomUUID()}`,
  ) {
    const deps = apiDeps(provider);
    const created = await createPayment(deps, context(), {
      amount: 1500,
      reference: `settle-${randomUUID()}`,
      paymentMethod: 'pm_card_visa',
    });
    const paymentId = (created.body as { payment: { id: string } }).payment.id;
    const capture = await capturePayment(deps, context(captureRequestId), { paymentId });
    expect(capture.status).toBe(200);
    return { paymentId, captureRequestId };
  }

  async function claimSettlement(): Promise<JobRecord> {
    await pool.query(
      `UPDATE jobs SET due_at = now() WHERE status = 'queued' AND type = 'settlement'`,
    );
    const [job] = await claimJobs(pool, {
      owner: 'worker:test',
      freeSlots: 1,
      leaseSeconds: 30,
      types: ['settlement'],
    });
    if (!job) throw new Error('expected a due settlement job');
    return job;
  }

  async function settleNext(deps: SettlementDeps) {
    const job = await claimSettlement();
    return settlePayment(deps, job, { generation: job.leaseGeneration });
  }

  async function state(paymentId: string) {
    return {
      payment: (
        await pool.query('SELECT state, version, settlement_review FROM payments WHERE id = $1', [
          paymentId,
        ])
      ).rows[0] as unknown,
      job: (
        await pool.query(
          `SELECT status, consecutive_failures, paused_reason, attempts FROM jobs
            WHERE payment_id = $1 AND type = 'settlement'`,
          [paymentId],
        )
      ).rows[0] as unknown,
      audit: (
        await pool.query<{ to_state: string }>(
          'SELECT to_state FROM audit_events WHERE payment_id = $1 ORDER BY occurred_at, to_state',
          [paymentId],
        )
      ).rows.map((row) => row.to_state),
    };
  }

  it('settles a captured payment about 10 s after capture, logging under the capture’s request and trace', async () => {
    const provider = providerWith(10_000);
    const { paymentId, captureRequestId } = await captured(provider);
    const heartbeat = new Heartbeat(createMetricsRegistry('worker'), 1_000);
    const worker = new Worker({
      pool,
      logger: logger(),
      owner: 'worker:settlement',
      concurrency: 1,
      pollIntervalMs: 100,
      leaseSeconds: 30,
      heartbeat,
      handlers: { settlement: settlementHandler(settlementDeps(provider, 1_000)) },
    });

    worker.start();
    try {
      for (let i = 0; i < 200; i += 1) {
        const row = await pool.query<{ state: string }>(
          'SELECT state FROM payments WHERE id = $1',
          [paymentId],
        );
        if (row.rows[0]?.state === 'settled') break;
        await sleep(100);
      }
    } finally {
      await worker.stop(2_000);
    }

    const audit = await pool.query<{
      to_state: string;
      actor: string;
      source: string;
      reason: string;
      operation_id: string | null;
      request_id: string;
      occurred_at: Date;
    }>(
      `SELECT to_state, actor, source, reason, operation_id, request_id, occurred_at FROM audit_events
          WHERE payment_id = $1 ORDER BY occurred_at, to_state`,
      [paymentId],
    );
    const capturedAt = audit.rows.find((row) => row.to_state === 'captured')?.occurred_at;
    const settledRow = audit.rows.find((row) => row.to_state === 'settled');
    expect(settledRow).toMatchObject({
      actor: 'system:settlement',
      source: 'worker',
      reason: 'settlement_confirmed',
      operation_id: null,
      request_id: captureRequestId,
    });
    const seconds =
      ((settledRow?.occurred_at.getTime() ?? 0) - (capturedAt?.getTime() ?? 0)) / 1000;
    expect(seconds).toBeGreaterThanOrEqual(10);
    expect(seconds).toBeLessThan(13);
    expect(await state(paymentId)).toMatchObject({
      payment: { state: 'settled', settlement_review: false },
      job: { status: 'completed', consecutive_failures: 0 },
      audit: ['pending', 'authorized', 'captured', 'settled'],
    });

    // Every settlement log line carries the capture's request ID and trace ID.
    // The worker's settlement lines; the API's own transition lines carry no worker context.
    const settlementLines = logs.filter(
      (line) =>
        line.paymentId === paymentId &&
        (line.event === 'job.claimed' ||
          line.event === 'job.poll_rescheduled' ||
          (line.event === 'payment.transitioned' && line.toState === 'settled')),
    );
    expect(settlementLines.map((line) => line.event)).toEqual(
      expect.arrayContaining(['job.claimed', 'job.poll_rescheduled', 'payment.transitioned']),
    );
    for (const line of settlementLines) {
      expect(line).toMatchObject({
        requestId: captureRequestId,
        traceId: TRACE_ID,
        workerRunId: expect.any(String),
      });
    }
  }, 30_000);

  it('polls while funds are pending without using the retry budget', async () => {
    const provider = providerWith(60_000);
    const { paymentId } = await captured(provider);
    await pool.query(
      `UPDATE jobs SET consecutive_failures = 2 WHERE payment_id = $1 AND type = 'settlement'`,
      [paymentId],
    );
    const deps = settlementDeps(provider);

    const outcomes = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await settleNext(deps));

    expect(outcomes).toEqual(Array.from({ length: 6 }, () => 'poll_rescheduled'));
    expect(await state(paymentId)).toMatchObject({
      payment: { state: 'captured', settlement_review: false },
      job: { status: 'queued', consecutive_failures: 0, attempts: 6 },
    });
  });

  it('retries an unreachable provider with backoff, then pauses and flags the payment', async () => {
    const real = providerWith(0);
    const { paymentId } = await captured(real);
    const unreachable = wrapProvider(real, {
      getSettlement: () =>
        Promise.reject(new ProviderUnavailableError(new Error('connection refused'))),
    });
    const deps = settlementDeps(unreachable);

    const outcomes = [];
    for (let i = 0; i < 4; i += 1) outcomes.push(await settleNext(deps));

    expect(outcomes).toEqual(['retry_scheduled', 'retry_scheduled', 'retry_scheduled', 'paused']);
    expect(await state(paymentId)).toMatchObject({
      payment: { state: 'captured', settlement_review: true },
      job: { status: 'paused', consecutive_failures: 4, paused_reason: 'retries_exhausted' },
      audit: ['pending', 'authorized', 'captured'],
    });
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'job.paused', reason: 'retries_exhausted' }),
    );
  });

  it('pauses at the review deadline without asking the provider', async () => {
    const real = providerWith(0);
    const { paymentId } = await captured(real);
    await pool.query(
      `UPDATE jobs SET review_deadline = now() - interval '1 second' WHERE payment_id = $1 AND type = 'settlement'`,
      [paymentId],
    );
    let asked = 0;
    const counting = wrapProvider(real, {
      getSettlement: (chargeId) => {
        asked += 1;
        return real.getSettlement(chargeId);
      },
    });

    expect(await settleNext(settlementDeps(counting))).toBe('paused');

    expect(asked).toBe(0);
    expect(await state(paymentId)).toMatchObject({
      payment: { state: 'captured', settlement_review: true },
      job: { status: 'paused', paused_reason: 'review_deadline_reached' },
    });
  });

  it('waits instead of settling while another operation on the payment is unresolved', async () => {
    const provider = providerWith(0);
    const { paymentId } = await captured(provider);
    await pool.query(
      `INSERT INTO operations (merchant_id, payment_id, action, idempotency_scope, idempotency_key, request_hash,
                               provider_key, expected_version, status, request_id)
       VALUES ($1, $2, 'refund', $5, $3, 'hash', $4, 2, 'reserved', 'req-other')`,
      [merchantId, paymentId, `key-${randomUUID()}`, `pk_${randomUUID()}`, `refund:${paymentId}`],
    );

    expect(await settleNext(settlementDeps(provider))).toBe('poll_rescheduled');

    expect(await state(paymentId)).toMatchObject({
      payment: { state: 'captured' },
      job: { status: 'queued' },
      audit: ['pending', 'authorized', 'captured'],
    });
  });

  it('completes the job without a transition when the payment is no longer captured', async () => {
    const provider = providerWith(0);
    const { paymentId } = await captured(provider);
    await pool.query(`UPDATE payments SET state = 'settled', version = version + 1 WHERE id = $1`, [
      paymentId,
    ]);

    expect(await settleNext(settlementDeps(provider))).toBe('not_applicable');

    expect(await state(paymentId)).toMatchObject({
      job: { status: 'completed' },
      audit: ['pending', 'authorized', 'captured'],
    });
  });

  it('discards the answer when another worker takes the job over during the provider call', async () => {
    const provider = providerWith(0);
    const { paymentId } = await captured(provider);
    const job = await claimSettlement();
    const takenOverMidCall = wrapProvider(provider, {
      getSettlement: async (chargeId) => {
        const answer = await provider.getSettlement(chargeId);
        // While this worker waits for the answer, its lease expires and another claims the job.
        await pool.query(
          'UPDATE jobs SET lease_generation = lease_generation + 1, lease_owner = $2 WHERE id = $1',
          [job.id, 'worker:other'],
        );
        return answer;
      },
    });

    expect(
      await settlePayment(settlementDeps(takenOverMidCall), job, {
        generation: job.leaseGeneration,
      }),
    ).toBe('lease_lost');

    expect(await state(paymentId)).toMatchObject({
      payment: { state: 'captured', settlement_review: false },
      job: { status: 'running' },
      audit: ['pending', 'authorized', 'captured'],
    });
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'job.lease_lost', jobId: job.id }),
    );
  });

  it('refuses mismatched work and a lost lease before asking the provider or writing', async () => {
    const provider = providerWith(0);
    const first = await captured(provider);
    const second = await captured(provider);
    await pool.query(
      `UPDATE jobs SET due_at = now() WHERE status = 'queued' AND type = 'settlement'`,
    );
    const jobs = await claimJobs(pool, {
      owner: 'worker:test',
      freeSlots: 2,
      leaseSeconds: 30,
      types: ['settlement'],
    });
    const jobA = jobs.find((job) => job.paymentId === first.paymentId);
    const jobB = jobs.find((job) => job.paymentId === second.paymentId);
    if (!jobA || !jobB) throw new Error('expected both settlement jobs');
    let asked = 0;
    const deps = settlementDeps(
      wrapProvider(provider, {
        getSettlement: (chargeId) => {
          asked += 1;
          return provider.getSettlement(chargeId);
        },
      }),
    );
    const snapshot = async () =>
      (await pool.query('SELECT * FROM jobs WHERE id = ANY($1) ORDER BY id', [[jobA.id, jobB.id]]))
        .rows as unknown;
    const before = {
      jobs: await snapshot(),
      a: await state(first.paymentId),
      b: await state(second.paymentId),
    };

    await expect(
      settlePayment(deps, { ...jobA, id: jobB.id }, { generation: jobA.leaseGeneration }),
    ).rejects.toBeInstanceOf(WorkMismatchError);
    await expect(
      settlePayment(
        deps,
        { ...jobA, type: 'operation_recovery' },
        { generation: jobA.leaseGeneration },
      ),
    ).rejects.toBeInstanceOf(WorkMismatchError);
    await pool.query('UPDATE jobs SET lease_generation = lease_generation + 1 WHERE id = $1', [
      jobA.id,
    ]);
    expect(await settlePayment(deps, jobA, { generation: jobA.leaseGeneration })).toBe(
      'lease_lost',
    );

    expect(asked).toBe(0);
    const after = {
      jobs: await snapshot(),
      a: await state(first.paymentId),
      b: await state(second.paymentId),
    };
    // Only the generation bump made by the test itself differs.
    expect(after.a).toEqual(before.a);
    expect(after.b).toEqual(before.b);
    expect(
      (after.jobs as { id: string; lease_expires_at: Date }[]).map((job) => job.lease_expires_at),
    ).toEqual(
      (before.jobs as { id: string; lease_expires_at: Date }[]).map((job) => job.lease_expires_at),
    );
  });
});
