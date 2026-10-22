import {
  findPaymentForMerchant,
  listOperations,
  listTransitions,
  type TransitionRecord,
  withTransaction,
} from '@payments/db';
import type { Pool } from 'pg';

import { canonicalPaymentId } from './ids';
import { toOperationResource, toPaymentResource } from './resources';

const UNRESOLVED = new Set(['reserved', 'awaiting_confirmation', 'needs_review']);

/** The Transition resource of spec §4.2, from one audit row. */
export function toTransitionResource(transition: TransitionRecord) {
  return {
    fromState: transition.fromState,
    toState: transition.toState,
    actor: transition.actor,
    source: transition.source,
    reason: transition.reason,
    requestId: transition.requestId,
    occurredAt: transition.occurredAt.toISOString(),
  };
}

/**
 * GET /payments/{id}: the payment with every operation and transition, oldest
 * first, read from one snapshot so they agree with each other. Undefined for
 * a malformed ID, a missing payment or another merchant's payment.
 */
export async function getPaymentDetails(pool: Pool, merchantId: string, rawPaymentId: string) {
  const paymentId = canonicalPaymentId(rawPaymentId);
  if (!paymentId) return undefined;

  return withTransaction(pool, async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const payment = await findPaymentForMerchant(client, paymentId, merchantId);
    if (!payment) return undefined;
    const operations = await listOperations(client, paymentId);
    const transitions = await listTransitions(client, paymentId);
    const pending = operations.find((operation) => UNRESOLVED.has(operation.status));

    return {
      payment: toPaymentResource(payment),
      pendingOperation: pending ? toOperationResource(pending) : null,
      operations: operations.map(toOperationResource),
      transitions: transitions.map(toTransitionResource),
    };
  });
}
