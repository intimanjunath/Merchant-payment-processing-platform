import {
  findJob,
  findOperation,
  findPayment,
  type JobRecord,
  lockOperation,
  markAwaitingConfirmation,
  markNeedsReview,
  type OperationRecord,
  type PaymentRecord,
  pauseJob,
  rescheduleJob,
  withTransaction,
} from '@payments/db';
import type { PaymentProvider } from '@payments/provider';

import { WorkMismatchError } from './errors';
import {
  assertSameWork,
  checkOwnership,
  type FinalizeDeps,
  finalizeOperation,
  type FinalOutcome,
  type WorkRef,
} from './finalize';
import { renewJobLease } from './jobs';
import { countingFailures, countJobRun } from './metrics';
import { callProvider, isProviderFailure, type ProviderFailure } from './provider-call';

export interface RecoveryDeps extends FinalizeDeps {
  provider: PaymentProvider;
  leaseSeconds: number;
  /** Retries allowed after the first recovery attempt (JOB_MAX_RETRIES). */
  maxRetries: number;
  /** First retry delay; doubles per consecutive failure (JOB_RETRY_BASE_MS). */
  retryBaseMs: number;
  /** Jitter source; tests pin it. */
  random?: () => number;
}

export type RecoveryOutcome =
  'finalized' | 'retry_scheduled' | 'paused' | 'lease_lost' | 'already_final' | 'version_conflict';

/**
 * Delay before the next attempt after `failures` consecutive failed attempts:
 * base × 1, 2, 4 … (2, 4, 8 s by default), each within ±20% so workers that
 * failed together don't all retry in the same instant.
 */
export function retryDelayMs(
  failures: number,
  baseMs: number,
  random: () => number = Math.random,
): number {
  const nominal = baseMs * 2 ** (failures - 1);
  return Math.round(nominal * (0.8 + 0.4 * random()));
}

/**
 * One recovery attempt for a claimed operation_recovery job (spec §3.4): the
 * lookup plus any re-send it requires. A definitive answer is finalized; a
 * timeout or unreachable provider anywhere in the attempt costs one unit of
 * the retry budget. Past the review deadline, or with the budget spent, the
 * work pauses as needs_review. Every write checks the lease generation, and
 * the lease is renewed before each provider call.
 */
export async function recoverOperation(
  deps: RecoveryDeps,
  job: JobRecord,
  run: { generation: number },
): Promise<RecoveryOutcome> {
  const outcome = await countingFailures(deps, 'operation_recovery', () =>
    recoveryAttempt(deps, job, run),
  );
  countJobRun(deps, 'operation_recovery', outcome);
  return outcome;
}

async function recoveryAttempt(
  deps: RecoveryDeps,
  job: JobRecord,
  run: { generation: number },
): Promise<RecoveryOutcome> {
  // Before any provider call or write (the lease renewal is a write): the
  // stored job must still be this record's work, and the operation this
  // payment's. Every later transaction checks the same again under its locks.
  if (job.type !== 'operation_recovery' || !job.operationId) {
    throw new WorkMismatchError(`job ${job.id} is not an operation_recovery job`);
  }
  const [stored, operation, payment] = await Promise.all([
    findJob(deps.pool, job.id),
    findOperation(deps.pool, job.operationId),
    findPayment(deps.pool, job.paymentId),
  ]);
  if (!stored || !operation || !payment) {
    throw new WorkMismatchError(`job ${job.id} refers to missing work`);
  }
  const work: WorkRef = {
    paymentId: job.paymentId,
    operationId: job.operationId,
    jobId: job.id,
    generation: run.generation,
  };
  assertSameWork(stored, operation, work);
  if (payment.id !== work.paymentId || payment.merchantId !== operation.merchantId) {
    throw new WorkMismatchError(`payment ${payment.id} is not operation ${operation.id}'s payment`);
  }

  if (Date.now() >= job.reviewDeadline.getTime()) {
    return pause(deps, work, job, 'review_deadline_reached', null);
  }

  const attempt = await attemptRecovery(deps, work, operation, payment);
  if (attempt === 'lease_lost') return 'lease_lost';
  if (isProviderFailure(attempt)) return recordFailedAttempt(deps, work, job, attempt.failure);
  return (await finalizeOperation(deps, work, attempt)).kind;
}

/** Lookup, then for capture or refund not received, a re-send with the same key. */
async function attemptRecovery(
  deps: RecoveryDeps,
  work: WorkRef,
  operation: OperationRecord,
  payment: PaymentRecord,
): Promise<FinalOutcome | ProviderFailure | 'lease_lost'> {
  const ids = (call: string) => ({
    paymentId: payment.id,
    operationId: operation.id,
    action: operation.action,
    call,
  });

  if (!(await renewJobLease(deps.pool, work, deps.leaseSeconds))) return 'lease_lost';
  const found = await callProvider(deps, ids('lookup'), () =>
    deps.provider.lookup({ kind: operation.action, providerKey: operation.providerKey }),
  );
  // Confirmed, rejected, a failed call, or a create the provider never received: all final for this attempt.
  if (
    isProviderFailure(found) ||
    found.outcome !== 'not_received' ||
    operation.action === 'authorize'
  ) {
    return found;
  }

  // Capture or refund the provider never received: send it again with the same key.
  const chargeId = payment.providerPaymentId;
  if (!chargeId) throw new Error('A payment being captured or refunded has no provider payment ID');
  if (!(await renewJobLease(deps.pool, work, deps.leaseSeconds))) return 'lease_lost';
  const request = {
    providerKey: operation.providerKey,
    chargeId,
    amountCents: payment.amountCents,
  };
  return callProvider(deps, ids(operation.action), () =>
    operation.action === 'capture' ? deps.provider.capture(request) : deps.provider.refund(request),
  );
}

/**
 * A failed attempt (operation → job locked, generation checked): retry after
 * the backoff, or pause when another retry would exceed the budget.
 */
async function recordFailedAttempt(
  deps: RecoveryDeps,
  work: WorkRef,
  job: JobRecord,
  reason: ProviderFailure['failure'],
): Promise<RecoveryOutcome> {
  const failures = job.consecutiveFailures + 1;
  if (failures > deps.maxRetries)
    return pause(deps, work, job, 'retries_exhausted', reason, failures);

  const delayMs = retryDelayMs(failures, deps.retryBaseMs, deps.random);
  const outcome = await withTransaction(deps.pool, async (client) => {
    const operation = await lockOperation(client, work.operationId);
    if (!operation) throw new WorkMismatchError(`operation ${work.operationId} does not exist`);
    const ownership = await checkOwnership(client, work, operation);
    if (ownership) return ownership;
    await markAwaitingConfirmation(client, operation.id, reason);
    await rescheduleJob(client, {
      jobId: work.jobId,
      dueInMs: delayMs,
      consecutiveFailures: failures,
      lastError: reason,
    });
    return 'retry_scheduled' as const;
  });

  if (outcome === 'retry_scheduled') {
    deps.logger.warn(
      {
        event: 'job.retry_scheduled',
        attempt: job.attempts,
        consecutiveFailures: failures,
        delayMs,
        reason,
      },
      'Recovery attempt failed; retry scheduled',
    );
  }
  return outcome;
}

/** needs_review: the operation stays unresolved (blocking new mutations) and the job stops. */
async function pause(
  deps: RecoveryDeps,
  work: WorkRef,
  job: JobRecord,
  reason: 'retries_exhausted' | 'review_deadline_reached',
  lastError: string | null,
  failures = job.consecutiveFailures,
): Promise<RecoveryOutcome> {
  const outcome = await withTransaction(deps.pool, async (client) => {
    const operation = await lockOperation(client, work.operationId);
    if (!operation) throw new WorkMismatchError(`operation ${work.operationId} does not exist`);
    const ownership = await checkOwnership(client, work, operation);
    if (ownership) return ownership;
    await markNeedsReview(client, operation.id, reason);
    await pauseJob(client, { jobId: work.jobId, reason, consecutiveFailures: failures, lastError });
    return 'paused' as const;
  });

  if (outcome === 'paused') {
    deps.logger.error(
      { event: 'job.paused', attempt: job.attempts, consecutiveFailures: failures, reason },
      'Recovery paused for review',
    );
  }
  return outcome;
}
