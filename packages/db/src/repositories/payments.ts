import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;

export type OperationAction = 'authorize' | 'capture' | 'refund';
export type OperationStatus =
  'reserved' | 'awaiting_confirmation' | 'needs_review' | 'succeeded' | 'rejected';

export interface PaymentRecord {
  id: string;
  merchantId: string;
  amountCents: number;
  currency: string;
  reference: string;
  /** A provider test token, never card data; never returned to clients. */
  paymentMethodToken: string;
  cardBrand: string;
  cardLast4: string;
  state: string;
  failureReason: string | null;
  providerPaymentId: string | null;
  settlementReview: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperationRecord {
  id: string;
  merchantId: string;
  paymentId: string;
  action: OperationAction;
  idempotencyScope: string;
  idempotencyKey: string;
  requestHash: string;
  providerKey: string;
  expectedVersion: number;
  status: OperationStatus;
  reason: string | null;
  responseStatus: number | null;
  responseBody: unknown;
  requestId: string;
  traceparent: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface JobRecord {
  id: string;
  type: 'operation_recovery' | 'settlement';
  workKey: string;
  paymentId: string;
  operationId: string | null;
  status: string;
  dueAt: Date;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  leaseGeneration: number;
  reviewDeadline: Date;
  requestId: string;
  traceparent: string | null;
}

const PAYMENT_COLUMNS = `
  id, merchant_id AS "merchantId", amount_cents::float8 AS "amountCents", currency, reference,
  payment_method_token AS "paymentMethodToken", card_brand AS "cardBrand", card_last4 AS "cardLast4",
  state, failure_reason AS "failureReason", provider_payment_id AS "providerPaymentId",
  settlement_review AS "settlementReview", version, created_at AS "createdAt", updated_at AS "updatedAt"`;

const OPERATION_COLUMNS = `
  id, merchant_id AS "merchantId", payment_id AS "paymentId", action,
  idempotency_scope AS "idempotencyScope", idempotency_key AS "idempotencyKey",
  request_hash AS "requestHash", provider_key AS "providerKey", expected_version AS "expectedVersion",
  status, reason, response_status AS "responseStatus", response_body AS "responseBody",
  request_id AS "requestId", traceparent, created_at AS "createdAt", updated_at AS "updatedAt",
  completed_at AS "completedAt"`;

const JOB_COLUMNS = `
  id, type, work_key AS "workKey", payment_id AS "paymentId", operation_id AS "operationId", status,
  due_at AS "dueAt", attempts, lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
  lease_generation::float8 AS "leaseGeneration", review_deadline AS "reviewDeadline",
  request_id AS "requestId", traceparent`;

function firstRow<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('Expected a row to be returned');
  return row;
}

export async function insertPayment(
  db: Db,
  payment: {
    merchantId: string;
    amountCents: number;
    reference: string;
    paymentMethodToken: string;
    cardBrand: string;
    cardLast4: string;
  },
): Promise<PaymentRecord> {
  const result = await db.query<PaymentRecord>(
    `INSERT INTO payments
       (merchant_id, amount_cents, reference, payment_method_token, card_brand, card_last4, state)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING ${PAYMENT_COLUMNS}`,
    [
      payment.merchantId,
      payment.amountCents,
      payment.reference,
      payment.paymentMethodToken,
      payment.cardBrand,
      payment.cardLast4,
    ],
  );
  return firstRow(result.rows);
}

export async function findPayment(db: Db, paymentId: string): Promise<PaymentRecord | undefined> {
  const result = await db.query<PaymentRecord>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1`,
    [paymentId],
  );
  return result.rows[0];
}

/**
 * Locks the merchant's payment for the rest of the transaction. Another
 * merchant's payment is indistinguishable from a missing one.
 */
export async function lockPaymentForMerchant(
  db: Db,
  paymentId: string,
  merchantId: string,
): Promise<PaymentRecord | undefined> {
  const result = await db.query<PaymentRecord>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 AND merchant_id = $2 FOR UPDATE`,
    [paymentId, merchantId],
  );
  return result.rows[0];
}

export async function findOperationByKey(
  db: Db,
  key: { merchantId: string; scope: string; idempotencyKey: string },
): Promise<OperationRecord | undefined> {
  const result = await db.query<OperationRecord>(
    `SELECT ${OPERATION_COLUMNS}
       FROM operations
      WHERE merchant_id = $1 AND idempotency_scope = $2 AND idempotency_key = $3`,
    [key.merchantId, key.scope, key.idempotencyKey],
  );
  return result.rows[0];
}

/** The payment's reserved, awaiting or paused operation, if it has one. */
export async function findUnresolvedOperation(
  db: Db,
  paymentId: string,
): Promise<OperationRecord | undefined> {
  const result = await db.query<OperationRecord>(
    `SELECT ${OPERATION_COLUMNS}
       FROM operations
      WHERE payment_id = $1 AND status IN ('reserved', 'awaiting_confirmation', 'needs_review')`,
    [paymentId],
  );
  return result.rows[0];
}

export async function insertOperation(
  db: Db,
  operation: {
    merchantId: string;
    paymentId: string;
    action: OperationAction;
    idempotencyScope: string;
    idempotencyKey: string;
    requestHash: string;
    providerKey: string;
    expectedVersion: number;
    requestId: string;
    traceparent: string | null;
  },
): Promise<OperationRecord> {
  const result = await db.query<OperationRecord>(
    `INSERT INTO operations
       (merchant_id, payment_id, action, idempotency_scope, idempotency_key, request_hash,
        provider_key, expected_version, status, request_id, traceparent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'reserved', $9, $10)
     RETURNING ${OPERATION_COLUMNS}`,
    [
      operation.merchantId,
      operation.paymentId,
      operation.action,
      operation.idempotencyScope,
      operation.idempotencyKey,
      operation.requestHash,
      operation.providerKey,
      operation.expectedVersion,
      operation.requestId,
      operation.traceparent,
    ],
  );
  return firstRow(result.rows);
}

/**
 * The operation's recovery job, inserted already leased to the caller
 * (generation 1). If the caller dies, the worker claims it after the lease
 * expires, like any other running job.
 */
export async function insertLeasedRecoveryJob(
  db: Db,
  job: {
    paymentId: string;
    operationId: string;
    leaseOwner: string;
    leaseSeconds: number;
    reviewDeadlineSeconds: number;
    requestId: string;
    traceparent: string | null;
  },
): Promise<JobRecord> {
  const result = await db.query<JobRecord>(
    `INSERT INTO jobs
       (type, work_key, payment_id, operation_id, status, due_at, lease_owner, lease_expires_at,
        lease_generation, review_deadline, request_id, traceparent)
     VALUES ('operation_recovery', $8, $1, $2, 'running', now(), $3,
             now() + make_interval(secs => $4), 1, now() + make_interval(secs => $5), $6, $7)
     RETURNING ${JOB_COLUMNS}`,
    [
      job.paymentId,
      job.operationId,
      job.leaseOwner,
      job.leaseSeconds,
      job.reviewDeadlineSeconds,
      job.requestId,
      job.traceparent,
      `recover:${job.operationId}`,
    ],
  );
  return firstRow(result.rows);
}

export async function insertAuditEvent(
  db: Db,
  event: {
    paymentId: string;
    merchantId: string;
    fromState: string | null;
    toState: string;
    actor: string;
    source: 'api' | 'worker';
    reason: string;
    operationId: string | null;
    requestId: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events
       (payment_id, merchant_id, from_state, to_state, actor, source, reason, operation_id, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      event.paymentId,
      event.merchantId,
      event.fromState,
      event.toState,
      event.actor,
      event.source,
      event.reason,
      event.operationId,
      event.requestId,
    ],
  );
}

/** True for a unique violation on the named constraint or index. */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === '23505' &&
    (error as { constraint?: unknown }).constraint === constraint
  );
}
