import { randomUUID } from 'node:crypto';

import {
  findOperationByKey,
  findPayment,
  findUnresolvedOperation,
  insertAuditEvent,
  insertLeasedRecoveryJob,
  insertOperation,
  insertPayment,
  isUniqueViolation,
  type JobRecord,
  lockPaymentForMerchant,
  type OperationRecord,
  type PaymentRecord,
  withTransaction,
} from '@payments/db';
import type { Logger, PaymentMetrics } from '@payments/observability';
import type { PaymentProvider } from '@payments/provider';
import type { Pool, PoolClient } from 'pg';

import {
  IdempotencyConflictError,
  OperationInProgressError,
  PaymentNotFoundError,
  UnknownPaymentMethodError,
  WorkMismatchError,
} from './errors';
import { canonicalPaymentId } from './ids';
import { metricsOf } from './metrics';
import { actionRequestHash, createRequestHash } from './request-hash';
import {
  assertActionAllowed,
  INITIAL_STATE,
  type PaymentAction,
  parsePaymentState,
} from './transitions';

export interface ReservationDeps {
  pool: Pool;
  provider: Pick<PaymentProvider, 'describePaymentMethod'>;
  logger: Logger;
  /** Identifies this process as the holder of the jobs it reserves. */
  leaseOwner: string;
  leaseSeconds: number;
  reviewDeadlineSeconds: number;
  /** Domain metrics; tests may leave them out. */
  metrics?: PaymentMetrics | undefined;
}

/** Who is asking, with which key, and the correlation the reserved job inherits. */
export interface MutationContext {
  merchantId: string;
  idempotencyKey: string;
  requestId: string;
  traceparent: string | null;
}

export interface CreateInput {
  amount: number;
  reference: string;
  paymentMethod: string;
}

/**
 * Either new work this caller now owns (it must call the provider next), or
 * an earlier operation with the same key and input: the API replays its saved
 * response, or answers 202 while it is unresolved.
 */
export type Reservation =
  | { kind: 'reserved'; payment: PaymentRecord; operation: OperationRecord; job: JobRecord }
  | { kind: 'replay'; payment: PaymentRecord; operation: OperationRecord };

const CREATE_SCOPE = 'create';
const IDEMPOTENCY_INDEX = 'operations_idempotency_key';

/**
 * TX1 for POST /payments: payment (pending, version 0), operation, a recovery
 * job leased to this process, and the creation audit row, committed together.
 * Only new rows are written, so nothing is locked. A concurrent request with
 * the same key waits on the idempotency index and then fails with a unique
 * violation; that transaction is rolled back and the winner's operation is
 * read in a fresh one, as a replay or a conflict.
 */
export async function reserveCreate(
  deps: ReservationDeps,
  context: MutationContext,
  input: CreateInput,
): Promise<Reservation> {
  const method = deps.provider.describePaymentMethod(input.paymentMethod);
  if (!method) throw new UnknownPaymentMethodError();
  const hash = createRequestHash(input);
  const key = {
    merchantId: context.merchantId,
    scope: CREATE_SCOPE,
    idempotencyKey: context.idempotencyKey,
  };

  try {
    const reservation = await withTransaction(deps.pool, async (client) => {
      const existing = await findOperationByKey(client, key);
      if (existing) return replayOrConflict(deps, client, existing, hash);

      const payment = await insertPayment(client, {
        merchantId: context.merchantId,
        amountCents: input.amount,
        reference: input.reference.trim(),
        paymentMethodToken: input.paymentMethod,
        cardBrand: method.brand,
        cardLast4: method.last4,
      });
      const { operation, job } = await insertOperationAndJob(deps, client, context, {
        payment,
        action: 'authorize',
        scope: CREATE_SCOPE,
        requestHash: hash,
      });
      await insertAuditEvent(client, {
        paymentId: payment.id,
        merchantId: context.merchantId,
        fromState: null,
        toState: INITIAL_STATE,
        actor: `merchant:${context.merchantId}`,
        source: 'api',
        reason: 'create_accepted',
        operationId: operation.id,
        requestId: context.requestId,
      });
      return { kind: 'reserved', payment, operation, job } as const;
    });
    return logCommitted(deps, reservation);
  } catch (error) {
    if (!isUniqueViolation(error, IDEMPOTENCY_INDEX)) throw error;
    return withTransaction(deps.pool, async (client) => {
      const existing = await findOperationByKey(client, key);
      if (!existing) throw error;
      return replayOrConflict(deps, client, existing, hash);
    });
  }
}

/**
 * TX1 for capture and refund, in the order of spec §2.7: lock the merchant's
 * payment (404 if absent), then, under that lock, replay or conflict, then
 * refuse if another operation is unresolved, then check the state. Holding
 * the payment lock is what stops two requests from both seeing it authorized
 * and both calling the provider. Locks: payment, then the new operation and
 * job. The audit row is written when the outcome is final.
 */
export async function reserveAction(
  deps: ReservationDeps,
  context: MutationContext,
  input: { paymentId: string; action: PaymentAction },
): Promise<Reservation> {
  // One spelling for the lock, scope and hash, or a differently cased ID escapes replay.
  const paymentId = canonicalPaymentId(input.paymentId);
  if (!paymentId) throw new PaymentNotFoundError();
  const hash = actionRequestHash({ action: input.action, paymentId });
  const scope = `${input.action}:${paymentId}`;

  const reservation = await withTransaction(deps.pool, async (client) => {
    const payment = await lockPaymentForMerchant(client, paymentId, context.merchantId);
    if (!payment) throw new PaymentNotFoundError();

    const existing = await findOperationByKey(client, {
      merchantId: context.merchantId,
      scope,
      idempotencyKey: context.idempotencyKey,
    });
    if (existing) return replayOrConflict(deps, client, existing, hash);

    const unresolved = await findUnresolvedOperation(client, payment.id);
    if (unresolved) throw new OperationInProgressError(unresolved.id);

    assertActionAllowed(parsePaymentState(payment.state), input.action);

    const { operation, job } = await insertOperationAndJob(deps, client, context, {
      payment,
      action: input.action,
      scope,
      requestHash: hash,
    });
    return { kind: 'reserved', payment, operation, job } as const;
  });
  return logCommitted(deps, reservation);
}

async function insertOperationAndJob(
  deps: ReservationDeps,
  client: PoolClient,
  context: MutationContext,
  work: {
    payment: PaymentRecord;
    action: OperationRecord['action'];
    scope: string;
    requestHash: string;
  },
): Promise<{ operation: OperationRecord; job: JobRecord }> {
  const operation = await insertOperation(client, {
    merchantId: context.merchantId,
    paymentId: work.payment.id,
    action: work.action,
    idempotencyScope: work.scope,
    idempotencyKey: context.idempotencyKey,
    requestHash: work.requestHash,
    providerKey: `pk_${randomUUID()}`,
    expectedVersion: work.payment.version,
    requestId: context.requestId,
    traceparent: context.traceparent,
  });
  const job = await insertLeasedRecoveryJob(client, {
    paymentId: work.payment.id,
    operationId: operation.id,
    leaseOwner: deps.leaseOwner,
    leaseSeconds: deps.leaseSeconds,
    reviewDeadlineSeconds: deps.reviewDeadlineSeconds,
    requestId: context.requestId,
    traceparent: context.traceparent,
  });
  return { operation, job };
}

async function replayOrConflict(
  deps: ReservationDeps,
  client: PoolClient,
  operation: OperationRecord,
  hash: string,
): Promise<Reservation> {
  if (operation.requestHash !== hash) {
    metricsOf(deps).idempotencyConflicts.inc({ action: operation.action });
    deps.logger.warn(
      { event: 'idempotency.conflict', operationId: operation.id, paymentId: operation.paymentId },
      'Idempotency key reused with a different request',
    );
    throw new IdempotencyConflictError(operation.id);
  }
  const payment = await findPayment(client, operation.paymentId);
  if (!payment)
    throw new WorkMismatchError(`operation ${operation.id} refers to a missing payment`);
  metricsOf(deps).idempotencyReplays.inc({ action: operation.action });
  deps.logger.debug(
    {
      event: 'idempotency.replayed',
      operationId: operation.id,
      paymentId: payment.id,
      status: operation.status,
    },
    'Idempotent replay',
  );
  return { kind: 'replay', payment, operation };
}

/** Logged only after TX1 committed, so the log never claims work that rolled back. */
function logCommitted(deps: ReservationDeps, reservation: Reservation): Reservation {
  if (reservation.kind === 'reserved' && reservation.operation.action === 'authorize') {
    // A new payment entered its first state.
    metricsOf(deps).transitions.inc({ from_state: 'none', to_state: 'pending' });
  }
  if (reservation.kind === 'reserved') {
    deps.logger.info(
      {
        event: 'operation.reserved',
        paymentId: reservation.payment.id,
        operationId: reservation.operation.id,
        jobId: reservation.job.id,
        action: reservation.operation.action,
      },
      'Operation reserved',
    );
  }
  return reservation;
}
