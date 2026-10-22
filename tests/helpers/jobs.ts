import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

export interface JobFixture {
  type?: 'operation_recovery' | 'settlement';
  status?: 'queued' | 'running' | 'paused' | 'completed' | 'cancelled';
  /** Due this many ms from now (negative: overdue). */
  dueInMs?: number;
  /** For running jobs: lease ends this many ms from now (negative: expired). */
  leaseEndsInMs?: number;
  generation?: number;
  requestId?: string;
  traceparent?: string | null;
}

/** A payment (and, for recovery, an operation) with one job in the given state. */
export async function insertJob(
  pool: Pool,
  fixture: JobFixture = {},
): Promise<{ jobId: string; paymentId: string }> {
  const type = fixture.type ?? 'operation_recovery';
  const status = fixture.status ?? 'queued';
  const merchant = await pool.query<{ id: string }>(
    'SELECT id FROM merchants ORDER BY email LIMIT 1',
  );
  const merchantId = merchant.rows[0]?.id;
  const payment = await pool.query<{ id: string }>(
    `INSERT INTO payments (merchant_id, amount_cents, reference, payment_method_token, card_brand, card_last4, state)
     VALUES ($1, 1000, $2, 'pm_card_visa', 'visa', '4242', 'pending') RETURNING id`,
    [merchantId, `job-fixture-${randomUUID()}`],
  );
  const paymentId = payment.rows[0]?.id ?? '';
  let operationId: string | null = null;
  if (type === 'operation_recovery') {
    const operation = await pool.query<{ id: string }>(
      `INSERT INTO operations (merchant_id, payment_id, action, idempotency_scope, idempotency_key,
                               request_hash, provider_key, expected_version, status, request_id)
       VALUES ($1, $2, 'authorize', 'create', $3, 'hash', $4, 0, 'awaiting_confirmation', 'req-fixture')
       RETURNING id`,
      [merchantId, paymentId, `key-${randomUUID()}`, `pk_${randomUUID()}`],
    );
    operationId = operation.rows[0]?.id ?? null;
  }
  const running = status === 'running';
  const job = await pool.query<{ id: string }>(
    `INSERT INTO jobs (type, work_key, payment_id, operation_id, status, due_at, lease_owner,
                       lease_expires_at, lease_generation, review_deadline, request_id, traceparent,
                       completed_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6::float8 / 1000),
             $7, CASE WHEN $8::float8 IS NULL THEN NULL ELSE now() + make_interval(secs => $8::float8 / 1000) END,
             $9, now() + interval '30 minutes', $10, $11,
             CASE WHEN $5 IN ('completed', 'cancelled') THEN now() END)
     RETURNING id`,
    [
      type,
      `${type === 'settlement' ? 'settle' : 'recover'}:${operationId ?? paymentId}`,
      paymentId,
      operationId,
      status,
      fixture.dueInMs ?? -1_000,
      running ? 'worker:someone-else' : null,
      running ? (fixture.leaseEndsInMs ?? 30_000) : null,
      fixture.generation ?? (running ? 1 : 0),
      fixture.requestId ?? `req-${randomUUID()}`,
      fixture.traceparent === undefined ? null : fixture.traceparent,
    ],
  );
  return { jobId: job.rows[0]?.id ?? '', paymentId };
}

export async function jobRow(pool: Pool, jobId: string) {
  const result = await pool.query<{
    status: string;
    lease_owner: string | null;
    lease_generation: string;
    attempts: number;
  }>('SELECT status, lease_owner, lease_generation, attempts FROM jobs WHERE id = $1', [jobId]);
  return result.rows[0];
}
