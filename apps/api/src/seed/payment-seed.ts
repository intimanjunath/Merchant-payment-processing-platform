import { findMerchantByEmail, findPayment } from '@payments/db';
import {
  formatTraceparent,
  resolveRequestId,
  runWithContext,
  startSpan,
} from '@payments/observability';
import {
  capturePayment,
  createPayment,
  InvalidStateTransitionError,
  type MutationContext,
  type MutationResponse,
  type PaymentDeps,
  refundPayment,
} from '@payments/payments';
import type { TestToken } from '@payments/provider';

type FollowUp = 'capture' | 'refund';

export interface SeedPayment {
  /** Fixed, so a re-run replays the stored operations instead of creating duplicates. */
  key: string;
  reference: string;
  amount: number;
  paymentMethod: TestToken;
  /** Actions after creation, in order. A refund waits until the worker has settled the capture. */
  then?: readonly FollowUp[];
}

/**
 * Development payments for the two seeded merchants: one of each outcome the
 * dashboard shows. pm_lost_response and pm_timeout are left for the worker to
 * recover, so they stay pending until it runs.
 */
export const SEED_PAYMENTS: Readonly<Record<string, readonly SeedPayment[]>> = {
  'merchant1@example.test': [
    {
      key: 'seed-acme-01',
      reference: 'ACME-1001 wholesale beans',
      amount: 18_450,
      paymentMethod: 'pm_card_visa',
      then: ['capture', 'refund'],
    },
    {
      key: 'seed-acme-02',
      reference: 'ACME-1002 cafe supplies',
      amount: 4_299,
      paymentMethod: 'pm_card_visa',
      then: ['capture'],
    },
    {
      key: 'seed-acme-03',
      reference: 'ACME-1003 espresso machine service',
      amount: 12_000,
      paymentMethod: 'pm_card_visa',
    },
    {
      key: 'seed-acme-04',
      reference: 'ACME-1004 office catering',
      amount: 2_650,
      paymentMethod: 'pm_card_declined',
    },
    {
      key: 'seed-acme-05',
      reference: 'ACME-1005 subscription box',
      amount: 3_500,
      paymentMethod: 'pm_lost_response',
    },
    {
      key: 'seed-acme-06',
      reference: 'ACME-1006 gift cards',
      amount: 5_000,
      paymentMethod: 'pm_timeout',
    },
  ],
  'merchant2@example.test': [
    {
      key: 'seed-blue-01',
      reference: 'BB-2001 road bike',
      amount: 129_900,
      paymentMethod: 'pm_card_visa',
      then: ['capture'],
    },
    {
      key: 'seed-blue-02',
      reference: 'BB-2002 tune-up',
      amount: 8_500,
      paymentMethod: 'pm_card_visa',
      then: ['capture', 'refund'],
    },
    {
      key: 'seed-blue-03',
      reference: 'BB-2003 helmet',
      amount: 6_499,
      paymentMethod: 'pm_card_visa',
    },
    {
      key: 'seed-blue-04',
      reference: 'BB-2004 rental deposit',
      amount: 20_000,
      paymentMethod: 'pm_card_declined',
    },
  ],
};

export interface SeededPayment {
  merchant: string;
  reference: string;
  state: string;
  /** What is still to happen, if anything. */
  waiting: 'settlement before refund' | 'worker recovery' | null;
}

/**
 * Creates the development payments through the payment services, the same
 * path as POST /payments and the capture and refund routes, so each one has
 * real provider records, operations and audit rows. Safe to run again: every
 * call uses a fixed idempotency key and replays once stored. A refund that
 * finds its payment still captured is not stored, and runs on a later pass
 * once the worker has settled the payment; any other rejection fails the run.
 */
export async function seedPayments(
  deps: PaymentDeps,
  plan: Readonly<Record<string, readonly SeedPayment[]>> = SEED_PAYMENTS,
): Promise<SeededPayment[]> {
  const seeded: SeededPayment[] = [];
  for (const [email, payments] of Object.entries(plan)) {
    const merchant = await findMerchantByEmail(deps.pool, email);
    if (!merchant) throw new Error(`Merchant ${email} is missing; run npm run db:seed first`);

    for (const payment of payments) {
      const context = (action: string) => mutationContext(merchant.id, `${payment.key}-${action}`);
      const created = await traced(context('create'), (ctx) =>
        createPayment(deps, ctx, {
          amount: payment.amount,
          reference: payment.reference,
          paymentMethod: payment.paymentMethod,
        }),
      );
      const paymentId = paymentIdOf(created);

      let waiting: SeededPayment['waiting'] = null;
      for (const action of payment.then ?? []) {
        const run = action === 'capture' ? capturePayment : refundPayment;
        try {
          await traced(context(action), (ctx) => run(deps, ctx, { paymentId }));
        } catch (error) {
          if (!isWaitingForSettlement(error)) throw error;
          waiting = 'settlement before refund';
        }
      }

      const stored = await findPayment(deps.pool, paymentId);
      if (!stored) throw new Error(`Seeded payment ${paymentId} is missing`);
      if (stored.state === 'pending') waiting = 'worker recovery';
      seeded.push({
        merchant: merchant.name,
        reference: payment.reference,
        state: stored.state,
        waiting,
      });
    }
  }
  return seeded;
}

/**
 * The one rejection a seed pass expects: a refund of a payment that is still
 * captured, which the worker has not settled yet. Any other invalid state is
 * a broken plan or broken data, and fails the seed.
 */
function isWaitingForSettlement(error: unknown): boolean {
  return (
    error instanceof InvalidStateTransitionError &&
    error.state === 'captured' &&
    error.attempted === 'refund'
  );
}

function mutationContext(merchantId: string, idempotencyKey: string): MutationContext {
  return { merchantId, idempotencyKey, requestId: resolveRequestId(undefined), traceparent: null };
}

/** Runs one call under its own request ID and trace, as the API's request tracking would. */
function traced(
  context: MutationContext,
  call: (context: MutationContext) => Promise<MutationResponse>,
): Promise<MutationResponse> {
  const span = startSpan();
  const withTrace = { ...context, traceparent: formatTraceparent(span) };
  return runWithContext(
    { requestId: context.requestId, traceId: span.traceId, spanId: span.spanId },
    () => call(withTrace),
  );
}

function paymentIdOf(response: MutationResponse): string {
  const body = response.body as { payment?: { id?: unknown } } | null;
  const id = body?.payment?.id;
  if (typeof id !== 'string') {
    throw new Error(`Create answered ${String(response.status)} without a payment`);
  }
  return id;
}
