import { createPool } from '@payments/db';
import { createLogger, createMetricsRegistry } from '@payments/observability';
import {
  capturePayment,
  claimJobs,
  InvalidStateTransitionError,
  listPaymentsPage,
  type PaymentDeps,
  settlePayment,
} from '@payments/payments';
import { createFakeProvider } from '@payments/provider';
import type { Pool } from 'pg';

import { loadConfig } from '../../apps/api/src/config/config';
import { createPaymentDeps } from '../../apps/api/src/payments/payment-deps';
import {
  SEED_PAYMENTS,
  type SeedPayment,
  seedPayments,
} from '../../apps/api/src/seed/payment-seed';
import { SEEDED_MERCHANTS } from '../helpers/api';
import { createScratchDatabase } from '../helpers/test-db';

const SECRET = 'test-only-secret-0123456789abcdef';

interface SeedEnvironment {
  scratch: { url: string; drop: () => Promise<void> };
  pool: Pool;
  deps: PaymentDeps;
}

/** A scratch database with the two merchants, and payment wiring built as the seed CLI builds it. */
async function seedEnvironment(): Promise<SeedEnvironment> {
  const scratch = await createScratchDatabase({ seed: true });
  const pool = createPool(scratch.url, { applicationName: 'payment-seed-test', max: 4 });
  const config = loadConfig({
    DATABASE_URL: scratch.url,
    JWT_SECRET: SECRET,
    CSRF_SECRET: SECRET,
    CURSOR_SECRET: SECRET,
    // Short enough that the two uncertain tokens stay quick; funds available at once.
    PROVIDER_TIMEOUT_MS: '100',
    SETTLEMENT_DELAY_MS: '0',
    WORKER_POLL_INTERVAL_MS: '1',
  });
  const deps = createPaymentDeps({
    config,
    logger: createLogger({ service: 'seed', level: 'silent' }),
    pool,
    metrics: createMetricsRegistry('seed-test'),
    role: 'seed',
  });
  return { scratch, pool, deps };
}

async function closeEnvironment(env: SeedEnvironment): Promise<void> {
  await env.pool.end();
  await env.scratch.drop();
}

describe('development payment seed', () => {
  let env: SeedEnvironment;
  let pool: Pool;
  let deps: PaymentDeps;

  beforeAll(async () => {
    env = await seedEnvironment();
    ({ pool, deps } = env);
  });

  afterAll(() => closeEnvironment(env));

  interface Counts {
    payments: number;
    operations: number;
    jobs: number;
    audit: number;
    charges: number;
    requests: number;
  }

  /** Every table a seed pass could write to, application and provider. */
  async function counts(): Promise<Counts> {
    const result = await pool.query<Counts>(
      `SELECT (SELECT count(*) FROM payments)::int AS payments,
              (SELECT count(*) FROM operations)::int AS operations,
              (SELECT count(*) FROM jobs)::int AS jobs,
              (SELECT count(*) FROM audit_events)::int AS audit,
              (SELECT count(*) FROM provider.charges)::int AS charges,
              (SELECT count(*) FROM provider.requests)::int AS requests`,
    );
    const row = result.rows[0];
    if (!row) throw new Error('count query returned no row');
    return row;
  }

  /** What the worker would do: run every due settlement job once. */
  async function settleDueJobs(): Promise<void> {
    const provider = createFakeProvider(pool, { timeoutMs: 100, settlementDelayMs: 0 });
    const jobs = await claimJobs(pool, {
      owner: 'worker:test',
      freeSlots: 10,
      leaseSeconds: 30,
      types: ['settlement'],
    });
    for (const job of jobs) {
      await settlePayment(
        {
          pool,
          logger: createLogger({ service: 'worker', level: 'silent' }),
          provider,
          leaseSeconds: 30,
          pollIntervalMs: 1_000,
          maxRetries: 3,
          retryBaseMs: 1_000,
        },
        job,
        { generation: job.leaseGeneration },
      );
    }
  }

  const summary = (seeded: Awaited<ReturnType<typeof seedPayments>>) =>
    seeded.map((payment) => [payment.reference, payment.state, payment.waiting]);

  it('creates each outcome once, replays on re-runs and refunds once settled', async () => {
    const first = await seedPayments(deps);
    expect(summary(first)).toEqual([
      ['ACME-1001 wholesale beans', 'captured', 'settlement before refund'],
      ['ACME-1002 cafe supplies', 'captured', null],
      ['ACME-1003 espresso machine service', 'authorized', null],
      ['ACME-1004 office catering', 'failed', null],
      ['ACME-1005 subscription box', 'pending', 'worker recovery'],
      ['ACME-1006 gift cards', 'pending', 'worker recovery'],
      ['BB-2001 road bike', 'captured', null],
      ['BB-2002 tune-up', 'captured', 'settlement before refund'],
      ['BB-2003 helmet', 'authorized', null],
      ['BB-2004 rental deposit', 'failed', null],
    ]);
    const afterFirst = await counts();
    expect(afterFirst.payments).toBe(10);

    // Nothing settled yet: a second pass replays everything and writes nothing.
    expect(summary(await seedPayments(deps))).toEqual(summary(first));
    expect(await counts()).toEqual(afterFirst);

    await settleDueJobs();
    const third = await seedPayments(deps);
    expect(summary(third).filter(([reference]) => /1001|2002/.test(String(reference)))).toEqual([
      ['ACME-1001 wholesale beans', 'refunded', null],
      ['BB-2002 tune-up', 'refunded', null],
    ]);
    const afterThird = await counts();
    expect(afterThird.payments).toBe(10);
    expect(afterThird.operations).toBe(afterFirst.operations + 2);

    // Fully seeded: further passes change nothing.
    expect(summary(await seedPayments(deps))).toEqual(summary(third));
    expect(await counts()).toEqual(afterThird);
  });

  it('gives each merchant only its own payments', async () => {
    for (const merchant of Object.values(SEEDED_MERCHANTS)) {
      const row = await pool.query<{ id: string }>('SELECT id FROM merchants WHERE email = $1', [
        merchant.email,
      ]);
      const page = await listPaymentsPage({ pool, cursorSecret: SECRET }, row.rows[0]?.id ?? '', {
        limit: 100,
      });
      const references = page.items.map((payment) => payment.reference).sort();
      const planned = (SEED_PAYMENTS[merchant.email] ?? []).map((payment) => payment.reference);
      expect(references).toEqual([...planned].sort());
    }
  });
});

describe('development payment seed with a custom plan', () => {
  let env: SeedEnvironment;

  beforeAll(async () => {
    env = await seedEnvironment();
  });

  afterAll(() => closeEnvironment(env));

  it('rejects a refund from Authorized instead of reporting a settlement wait', async () => {
    const plan = {
      [SEEDED_MERCHANTS.acme.email]: [
        {
          key: 'seed-test-refund-authorized',
          reference: 'TEST refund from authorized',
          amount: 1_000,
          paymentMethod: 'pm_card_visa',
          then: ['refund'],
        },
      ],
    } satisfies Record<string, SeedPayment[]>;

    const attempt = seedPayments(env.deps, plan);
    await expect(attempt).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(attempt).rejects.toMatchObject({ state: 'authorized', attempted: 'refund' });

    // The rejected refund stored nothing: the payment has its create operation only.
    const operations = await env.pool.query<{ action: string }>(
      `SELECT o.action FROM operations o JOIN payments p ON p.id = o.payment_id
        WHERE p.reference = 'TEST refund from authorized'`,
    );
    expect(operations.rows).toEqual([{ action: 'authorize' }]);
  });

  it('rejects a capture of an already captured payment instead of reporting a settlement wait', async () => {
    const entry: SeedPayment = {
      key: 'seed-test-capture-captured',
      reference: 'TEST capture when captured',
      amount: 1_000,
      paymentMethod: 'pm_card_visa',
    };
    const created = await seedPayments(env.deps, { [SEEDED_MERCHANTS.acme.email]: [entry] });
    const merchant = await env.pool.query<{ id: string; paymentId: string }>(
      `SELECT merchant_id AS id, id AS "paymentId" FROM payments WHERE reference = $1`,
      [entry.reference],
    );
    const row = merchant.rows[0];
    if (!row) throw new Error('seeded payment missing');
    expect(created.map((payment) => payment.state)).toEqual(['authorized']);

    // Captured outside the seed, under another key: the seed's own capture finds it captured.
    await capturePayment(
      env.deps,
      {
        merchantId: row.id,
        idempotencyKey: 'outside-the-seed',
        requestId: 'req-outside',
        traceparent: null,
      },
      { paymentId: row.paymentId },
    );

    const attempt = seedPayments(env.deps, {
      [SEEDED_MERCHANTS.acme.email]: [{ ...entry, then: ['capture'] }],
    });
    await expect(attempt).rejects.toBeInstanceOf(InvalidStateTransitionError);
    await expect(attempt).rejects.toMatchObject({ state: 'captured', attempted: 'capture' });
  });
});
