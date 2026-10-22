import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { createPool, type JobRecord } from '@payments/db';
import { createLogger } from '@payments/observability';
import {
  claimJobs,
  createPayment,
  finalizeOperation,
  type MutationResponse,
  type PaymentDeps,
} from '@payments/payments';
import { createFakeProvider, type FakeProvider } from '@payments/provider';
import type { Pool } from 'pg';

import { SEEDED_MERCHANTS } from '../helpers/api';
import { wrapProvider } from '../helpers/provider';
import { createScratchDatabase } from '../helpers/test-db';

const LEASE_SECONDS = 1;

/**
 * Core recovery test (design §6.1): the API (owner A) is mid-call
 * when its lease expires; a worker (owner B) claims the job, looks the outcome
 * up and finalizes. A's late answer must change nothing, whether it arrives
 * after B finalized or between B's claim and B's finalization.
 */
describe('lease takeover', () => {
  let scratch: { url: string; drop: () => Promise<void> };
  let pool: Pool;
  let inner: FakeProvider;
  let merchantId: string;
  const logs: Record<string, unknown>[] = [];

  beforeAll(async () => {
    scratch = await createScratchDatabase({ seed: true });
    pool = createPool(scratch.url, { applicationName: 'lease-takeover', max: 10 });
    inner = createFakeProvider(pool, { timeoutMs: 100, settlementDelayMs: 0 });
    const merchant = await pool.query<{ id: string }>('SELECT id FROM merchants WHERE email = $1', [
      SEEDED_MERCHANTS.acme.email,
    ]);
    merchantId = merchant.rows[0]?.id ?? '';
  });

  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  function depsWith(provider: PaymentDeps['provider']): PaymentDeps {
    return {
      pool,
      logger: createLogger({
        service: 'api',
        level: 'debug',
        destination: new Writable({
          write(chunk: Buffer, _encoding, done) {
            logs.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
            done();
          },
        }),
      }),
      provider,
      source: 'api',
      leaseOwner: 'api:A',
      leaseSeconds: LEASE_SECONDS,
      reviewDeadlineSeconds: 1_800,
      settlementPollMs: 5_000,
      recoveryDelayMs: 5_000,
    };
  }

  /**
   * Owner A reserves (generation 1) and calls the provider, which stores the
   * effect and then holds A's answer until `release()`. Resolves once A is
   * mid-call and its lease has expired.
   */
  async function ownerAStuckMidCall() {
    let markInCall: () => void = () => undefined;
    const inCall = new Promise<void>((resolve) => {
      markInCall = resolve;
    });
    let release: () => void = () => undefined;
    const mayAnswer = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = depsWith(
      wrapProvider(inner, {
        authorize: async (req) => {
          const result = await inner.authorize(req);
          markInCall();
          await mayAnswer;
          return result;
        },
      }),
    );
    const answer: Promise<MutationResponse> = createPayment(
      deps,
      {
        merchantId,
        idempotencyKey: `key-${randomUUID()}`,
        requestId: `req-${randomUUID()}`,
        traceparent: null,
      },
      { amount: 1500, reference: `takeover-${randomUUID()}`, paymentMethod: 'pm_card_visa' },
    );
    await inCall;
    const operation = (
      await pool.query<{ id: string; payment_id: string; provider_key: string }>(
        'SELECT id, payment_id, provider_key FROM operations ORDER BY created_at DESC LIMIT 1',
      )
    ).rows[0];
    if (!operation) throw new Error('expected the reserved operation');
    await sleep(LEASE_SECONDS * 1000 + 200);
    return { deps, answer, operation, release };
  }

  async function ownerBClaims(): Promise<JobRecord> {
    const [job] = await claimJobs(pool, {
      owner: 'worker:B',
      freeSlots: 1,
      leaseSeconds: 30,
      types: ['operation_recovery'],
    });
    if (!job) throw new Error('expected B to claim the expired job');
    expect(job.leaseGeneration).toBe(2);
    return job;
  }

  async function ownerBFinalizes(
    deps: PaymentDeps,
    operation: { id: string; payment_id: string; provider_key: string },
    job: JobRecord,
  ) {
    const outcome = await inner.lookup({ kind: 'authorize', providerKey: operation.provider_key });
    return finalizeOperation(
      { ...deps, source: 'worker' },
      { paymentId: operation.payment_id, operationId: operation.id, jobId: job.id, generation: 2 },
      outcome,
    );
  }

  it("rejects A's answer arriving after B finalized, leaving B's result untouched", async () => {
    const a = await ownerAStuckMidCall();
    const job = await ownerBClaims();
    const byB = await ownerBFinalizes(a.deps, a.operation, job);
    expect(byB.kind).toBe('finalized');
    const afterB = await snapshot(a.operation.payment_id);

    a.release();
    const answer = await a.answer;

    expect(await snapshot(a.operation.payment_id)).toEqual(afterB);
    expect(answer).toEqual(byB.kind === 'finalized' ? byB.response : undefined);
    expectFinalizedOnceByB(afterB);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'job.lease_lost', jobId: job.id, generation: 1 }),
    );
  });

  it("rejects A's answer arriving between B's claim and B's finalization", async () => {
    const a = await ownerAStuckMidCall();
    const job = await ownerBClaims();
    const beforeA = await snapshot(a.operation.payment_id);

    // A answers first: only the lease generation stops it, the operation is still open.
    a.release();
    const answer = await a.answer;

    expect(await snapshot(a.operation.payment_id)).toEqual(beforeA);
    expect(answer.status).toBe(202);
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'job.lease_lost', jobId: job.id, generation: 1 }),
    );

    // B, still the owner, finalizes normally.
    expect((await ownerBFinalizes(a.deps, a.operation, job)).kind).toBe('finalized');
    expectFinalizedOnceByB(await snapshot(a.operation.payment_id));
  });

  function expectFinalizedOnceByB(state: Awaited<ReturnType<typeof snapshot>>): void {
    // Spec §5.3: an authorized create totals two audit rows, the second by the worker.
    expect(state.audit).toEqual([
      { from_state: null, to_state: 'pending', source: 'api' },
      { from_state: 'pending', to_state: 'authorized', source: 'worker' },
    ]);
    expect(state.payment).toEqual({ state: 'authorized', version: 1 });
    expect(state.operation).toEqual({ status: 'succeeded', response_status: 201 });
    expect(state.job).toEqual({ status: 'completed', lease_owner: null, lease_generation: '2' });
    expect(state.charges).toBe(1);
  }

  async function snapshot(paymentId: string) {
    const one = async (sql: string) => (await pool.query(sql, [paymentId])).rows[0] as unknown;
    return {
      payment: await one('SELECT state, version FROM payments WHERE id = $1'),
      operation: await one('SELECT status, response_status FROM operations WHERE payment_id = $1'),
      job: await one(
        'SELECT status, lease_owner, lease_generation FROM jobs WHERE payment_id = $1',
      ),
      audit: (
        await pool.query(
          'SELECT from_state, to_state, source FROM audit_events WHERE payment_id = $1 ORDER BY occurred_at, to_state',
          [paymentId],
        )
      ).rows as unknown,
      charges: Number(
        (
          await pool.query<{ n: string }>(
            `SELECT count(*) AS n FROM provider.charges c
               JOIN provider.requests r ON r.charge_id = c.id
               JOIN operations o ON o.provider_key = r.provider_key
              WHERE o.payment_id = $1`,
            [paymentId],
          )
        ).rows[0]?.n,
      ),
    };
  }
});
