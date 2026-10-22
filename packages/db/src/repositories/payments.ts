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
  consecutiveFailures: number;
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
  due_at AS "dueAt", attempts, consecutive_failures AS "consecutiveFailures", lease_owner AS "leaseOwner", lease_expires_at AS "leaseExpiresAt",
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

// Finalization and recovery scheduling. Callers lock in the order
// payment → operation → job and skip rows they don't need.

export async function findOperation(
  db: Db,
  operationId: string,
): Promise<OperationRecord | undefined> {
  const result = await db.query<OperationRecord>(
    `SELECT ${OPERATION_COLUMNS} FROM operations WHERE id = $1`,
    [operationId],
  );
  return result.rows[0];
}

export async function lockPayment(db: Db, paymentId: string): Promise<PaymentRecord | undefined> {
  const result = await db.query<PaymentRecord>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 FOR UPDATE`,
    [paymentId],
  );
  return result.rows[0];
}

export async function lockOperation(
  db: Db,
  operationId: string,
): Promise<OperationRecord | undefined> {
  const result = await db.query<OperationRecord>(
    `SELECT ${OPERATION_COLUMNS} FROM operations WHERE id = $1 FOR UPDATE`,
    [operationId],
  );
  return result.rows[0];
}

/** Locks the job row; the caller compares its lease generation with its own. */
export async function lockJob(db: Db, jobId: string): Promise<JobRecord | undefined> {
  const result = await db.query<JobRecord>(
    `SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1 FOR UPDATE`,
    [jobId],
  );
  return result.rows[0];
}

/**
 * The compare-and-set transition: state and failure reason change together,
 * and only if the payment is still at the version and state the operation
 * expected. Undefined when no row matched.
 */
export async function transitionPayment(
  db: Db,
  change: {
    paymentId: string;
    expectedVersion: number;
    from: string;
    to: string;
    failureReason: string | null;
    providerPaymentId: string | null;
  },
): Promise<PaymentRecord | undefined> {
  const result = await db.query<PaymentRecord>(
    `UPDATE payments
        SET state = $4,
            failure_reason = $5,
            provider_payment_id = coalesce($6, provider_payment_id),
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND version = $2 AND state = $3
      RETURNING ${PAYMENT_COLUMNS}`,
    [
      change.paymentId,
      change.expectedVersion,
      change.from,
      change.to,
      change.failureReason,
      change.providerPaymentId,
    ],
  );
  return result.rows[0];
}

export async function resolveOperation(
  db: Db,
  resolution: { operationId: string; status: 'succeeded' | 'rejected'; reason: string | null },
): Promise<OperationRecord> {
  const result = await db.query<OperationRecord>(
    `UPDATE operations
        SET status = $2, reason = $3, completed_at = now(), updated_at = now()
      WHERE id = $1
      RETURNING ${OPERATION_COLUMNS}`,
    [resolution.operationId, resolution.status, resolution.reason],
  );
  return firstRow(result.rows);
}

/** The response a replay of this operation's key returns from now on. */
export async function saveOperationResponse(
  db: Db,
  operationId: string,
  response: { status: number; body: unknown },
): Promise<void> {
  await db.query(`UPDATE operations SET response_status = $2, response_body = $3 WHERE id = $1`, [
    operationId,
    response.status,
    JSON.stringify(response.body),
  ]);
}

export async function completeJob(db: Db, jobId: string): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
            completed_at = now(), updated_at = now()
      WHERE id = $1`,
    [jobId],
  );
}

/**
 * Schedules the settlement check for a captured payment. It inherits the
 * capture's request ID and trace context, so settlement logs join the same
 * trace. A second insert for the same payment does nothing.
 */
export async function insertSettlementJob(
  db: Db,
  job: {
    paymentId: string;
    dueInMs: number;
    reviewDeadlineSeconds: number;
    requestId: string;
    traceparent: string | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO jobs (type, work_key, payment_id, status, due_at, review_deadline, request_id, traceparent)
     VALUES ('settlement', $2, $1, 'queued', now() + make_interval(secs => $3::float8 / 1000),
             now() + make_interval(secs => $4), $5, $6)
     ON CONFLICT (work_key) DO NOTHING`,
    [
      job.paymentId,
      `settle:${job.paymentId}`,
      job.dueInMs,
      job.reviewDeadlineSeconds,
      job.requestId,
      job.traceparent,
    ],
  );
}

export async function markAwaitingConfirmation(
  db: Db,
  operationId: string,
  reason: string,
): Promise<OperationRecord> {
  const result = await db.query<OperationRecord>(
    `UPDATE operations SET status = 'awaiting_confirmation', reason = $2, updated_at = now()
      WHERE id = $1
      RETURNING ${OPERATION_COLUMNS}`,
    [operationId, reason],
  );
  return firstRow(result.rows);
}

/** Hands the job back to the queue: lease cleared, due again after the delay. */
export async function requeueJob(
  db: Db,
  job: { jobId: string; dueInMs: number; lastError: string },
): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
            due_at = now() + make_interval(secs => $2::float8 / 1000),
            last_error = $3, updated_at = now()
      WHERE id = $1`,
    [job.jobId, job.dueInMs, job.lastError],
  );
}

// Reads for the payment details view.

export interface TransitionRecord {
  fromState: string | null;
  toState: string;
  actor: string;
  source: 'api' | 'worker';
  reason: string;
  requestId: string;
  occurredAt: Date;
}

export async function findPaymentForMerchant(
  db: Db,
  paymentId: string,
  merchantId: string,
): Promise<PaymentRecord | undefined> {
  const result = await db.query<PaymentRecord>(
    `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE id = $1 AND merchant_id = $2`,
    [paymentId, merchantId],
  );
  return result.rows[0];
}

/** Every operation on the payment, oldest first, including rejected and paused ones. */
export async function listOperations(db: Db, paymentId: string): Promise<OperationRecord[]> {
  const result = await db.query<OperationRecord>(
    `SELECT ${OPERATION_COLUMNS} FROM operations WHERE payment_id = $1 ORDER BY created_at, id`,
    [paymentId],
  );
  return result.rows;
}

/** The audit trail, oldest first. */
export async function listTransitions(db: Db, paymentId: string): Promise<TransitionRecord[]> {
  const result = await db.query<TransitionRecord>(
    `SELECT from_state AS "fromState", to_state AS "toState", actor, source, reason,
            request_id AS "requestId", occurred_at AS "occurredAt"
       FROM audit_events
      WHERE payment_id = $1
      ORDER BY occurred_at, id`,
    [paymentId],
  );
  return result.rows;
}

// The payment list (spec §5.5). Exported so a test can EXPLAIN exactly what runs.
// $3 is a ready ILIKE pattern ('%' || escaped || '%'); backslash is the escape.
// The cursor key keeps PostgreSQL's microseconds: a JavaScript Date would round
// them away and make keyset paging skip or repeat rows created in one millisecond.
export const LIST_PAYMENTS_SQL = `
  SELECT ${PAYMENT_COLUMNS},
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursorCreatedAt"
    FROM payments
   WHERE merchant_id = $1
     AND ($2::text IS NULL OR state = $2)
     AND ($3::text IS NULL OR reference ILIKE $3 ESCAPE '\\')
     AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
   ORDER BY created_at DESC, id DESC
   LIMIT $6`;

export interface ListedPayment extends PaymentRecord {
  /** created_at to the microsecond, for the next page's cursor. */
  cursorCreatedAt: string;
}

/** Escapes ILIKE wildcards so `%` and `_` in a search match themselves. */
export function substringPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export async function listPayments(
  db: Db,
  query: {
    merchantId: string;
    state: string | null;
    search: string | null;
    after: { createdAt: string; id: string } | null;
    limit: number;
  },
): Promise<ListedPayment[]> {
  const result = await db.query<ListedPayment>(LIST_PAYMENTS_SQL, [
    query.merchantId,
    query.state,
    query.search === null ? null : substringPattern(query.search),
    query.after?.createdAt ?? null,
    query.after?.id ?? null,
    query.limit,
  ]);
  return result.rows;
}

// Claiming and leases (spec §5.5). Both touch only the job row.

/**
 * Claims up to `limit` due jobs of the given types for `owner`: queued jobs
 * that are due, and running jobs whose lease expired. SKIP LOCKED means two
 * workers never wait on, or both take, the same row. Each claim raises the
 * lease generation, so a previous owner's late write can be told apart, and
 * counts one attempt.
 */
export async function claimDueJobs(
  db: Db,
  claim: { owner: string; limit: number; leaseSeconds: number; types: readonly string[] },
): Promise<JobRecord[]> {
  const result = await db.query<JobRecord>(
    `WITH next AS (
       SELECT id AS next_id FROM jobs
        WHERE type = ANY($4::text[])
          AND ((status = 'queued' AND due_at <= now())
            OR (status = 'running' AND lease_expires_at <= now()))
        ORDER BY due_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs j
        SET status = 'running',
            lease_owner = $2,
            lease_expires_at = now() + make_interval(secs => $3),
            lease_generation = j.lease_generation + 1,
            attempts = j.attempts + 1,
            updated_at = now()
       FROM next
      WHERE j.id = next.next_id
      RETURNING ${JOB_COLUMNS}`,
    [claim.limit, claim.owner, claim.leaseSeconds, claim.types],
  );
  return result.rows;
}

/** Extends the lease if the caller still holds this generation; false means it was taken over. */
export async function renewLease(
  db: Db,
  lease: { jobId: string; generation: number; leaseSeconds: number },
): Promise<boolean> {
  const result = await db.query(
    `UPDATE jobs
        SET lease_expires_at = now() + make_interval(secs => $3), updated_at = now()
      WHERE id = $1 AND status = 'running' AND lease_generation = $2`,
    [lease.jobId, lease.generation, lease.leaseSeconds],
  );
  return result.rowCount === 1;
}

// Recovery outcomes (step 13). Callers lock operation → job and check the lease generation first.

/** Back to the queue after a failed attempt: lease cleared, failure count recorded, due after the backoff. */
export async function rescheduleJob(
  db: Db,
  job: { jobId: string; dueInMs: number; consecutiveFailures: number; lastError: string },
): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
            due_at = now() + make_interval(secs => $2::float8 / 1000),
            consecutive_failures = $3, last_error = $4, updated_at = now()
      WHERE id = $1`,
    [job.jobId, job.dueInMs, job.consecutiveFailures, job.lastError],
  );
}

/** Stops automatic processing: the job waits, with its reason, until an operator resumes it. */
export async function pauseJob(
  db: Db,
  job: { jobId: string; reason: string; consecutiveFailures: number; lastError: string | null },
): Promise<void> {
  await db.query(
    `UPDATE jobs
        SET status = 'paused', lease_owner = NULL, lease_expires_at = NULL,
            paused_reason = $2, consecutive_failures = $3, last_error = coalesce($4, last_error),
            updated_at = now()
      WHERE id = $1`,
    [job.jobId, job.reason, job.consecutiveFailures, job.lastError],
  );
}

/** The dead-letter state for an operation: unresolved, blocking new mutations, needing a person. */
export async function markNeedsReview(db: Db, operationId: string, reason: string): Promise<void> {
  await db.query(
    `UPDATE operations SET status = 'needs_review', reason = $2, updated_at = now() WHERE id = $1`,
    [operationId, reason],
  );
}

/** The job row as stored, unlocked; used to check a claimed record still describes the same work. */
export async function findJob(db: Db, jobId: string): Promise<JobRecord | undefined> {
  const result = await db.query<JobRecord>(`SELECT ${JOB_COLUMNS} FROM jobs WHERE id = $1`, [
    jobId,
  ]);
  return result.rows[0];
}
