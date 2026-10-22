import {
  completeJob,
  findJob,
  findPayment,
  findUnresolvedOperation,
  flagSettlementReview,
  insertAuditEvent,
  type JobRecord,
  lockJob,
  lockPayment,
  pauseJob,
  type PaymentRecord,
  rescheduleJob,
  transitionPayment,
  withTransaction,
} from '@payments/db';
import type { Logger, PaymentMetrics } from '@payments/observability';
import type { PaymentProvider } from '@payments/provider';
import type { Pool, PoolClient } from 'pg';

import { WorkMismatchError } from './errors';
import { renewJobLease } from './jobs';
import { countingFailures, countJobRun, metricsOf } from './metrics';
import { callProvider, isProviderFailure } from './provider-call';
import { retryDelayMs } from './recovery';
import { parsePaymentState, transition } from './transitions';

export interface SettlementDeps {
  pool: Pool;
  logger: Logger;
  provider: Pick<PaymentProvider, 'getSettlement'>;
  leaseSeconds: number;
  /** How long to wait before asking again while funds are pending (WORKER_POLL_INTERVAL_MS). */
  pollIntervalMs: number;
  maxRetries: number;
  retryBaseMs: number;
  random?: () => number;
  /** Domain metrics; tests may leave them out. */
  metrics?: PaymentMetrics | undefined;
}

export type SettlementOutcome =
  | 'settled'
  | 'poll_rescheduled'
  | 'retry_scheduled'
  | 'paused'
  | 'not_applicable'
  | 'lease_lost'
  | 'already_final';

/** The settlement job being run and the lease generation this run holds. */
interface SettlementWork {
  paymentId: string;
  jobId: string;
  generation: number;
}

type Stop = 'lease_lost' | 'already_final';

/**
 * One settlement attempt for a claimed settlement job. Asks the provider
 * whether the captured funds are available; once they are, moves the payment
 * from captured to settled. Pending funds are an ordinary wait (polled again,
 * no retry budget used); a timeout or unreachable provider costs one unit of
 * the budget. Retries exhausted or the review deadline pause the job and flag
 * the payment for settlement review; the payment stays captured.
 */
export async function settlePayment(
  deps: SettlementDeps,
  job: JobRecord,
  run: { generation: number },
): Promise<SettlementOutcome> {
  const outcome = await countingFailures(deps, 'settlement', () =>
    settlementAttempt(deps, job, run),
  );
  countJobRun(deps, 'settlement', outcome);
  return outcome;
}

async function settlementAttempt(
  deps: SettlementDeps,
  job: JobRecord,
  run: { generation: number },
): Promise<SettlementOutcome> {
  // Before any provider call or write: the stored job is a settlement job for this payment.
  if (job.type !== 'settlement' || job.operationId !== null) {
    throw new WorkMismatchError(`job ${job.id} is not a settlement job`);
  }
  const [stored, payment] = await Promise.all([
    findJob(deps.pool, job.id),
    findPayment(deps.pool, job.paymentId),
  ]);
  if (!stored || !payment) throw new WorkMismatchError(`job ${job.id} refers to missing work`);
  assertSettlementJob(stored, job.paymentId);
  const work: SettlementWork = { paymentId: payment.id, jobId: job.id, generation: run.generation };

  if (Date.now() >= job.reviewDeadline.getTime()) {
    return pause(deps, work, job, 'review_deadline_reached', null);
  }

  const chargeId = payment.providerPaymentId;
  if (!chargeId) throw new Error('A captured payment has no provider payment ID');
  if (!(await renewJobLease(deps.pool, work, deps.leaseSeconds))) return 'lease_lost';
  const answer = await callProvider(
    deps,
    { paymentId: payment.id, action: 'settle', call: 'getSettlement' },
    async () => {
      const settlement = await deps.provider.getSettlement(chargeId);
      return { outcome: settlement.status };
    },
  );

  if (isProviderFailure(answer)) return retryOrPause(deps, work, job, answer.failure);
  if (answer.outcome === 'pending') return reschedule(deps, work, job, 'poll_rescheduled');
  return settle(deps, work, job);
}

/** Payment → job: recheck under the payment lock, then captured → settled with its audit row. */
async function settle(
  deps: SettlementDeps,
  work: SettlementWork,
  job: JobRecord,
): Promise<SettlementOutcome> {
  const outcome = await withTransaction(
    deps.pool,
    async (client): Promise<SettlementOutcome | 'wait'> => {
      const payment = await lockPayment(client, work.paymentId);
      if (!payment) throw new WorkMismatchError(`payment ${work.paymentId} does not exist`);
      const stop = await checkSettlementOwnership(client, work);
      if (stop) return stop;

      if (payment.state !== 'captured') {
        // Settled some other way, or the state moved on: nothing left for this job.
        await completeJob(client, work.jobId);
        return 'not_applicable';
      }
      if (await findUnresolvedOperation(client, payment.id)) return 'wait';

      const rule = transition(parsePaymentState(payment.state), 'settlement_confirmed');
      const settled = await transitionPayment(client, {
        paymentId: payment.id,
        expectedVersion: payment.version,
        from: rule.from,
        to: rule.to,
        failureReason: null,
        providerPaymentId: null,
      });
      if (!settled) throw new Error('Settlement compare-and-set failed under the payment lock');
      await insertAuditEvent(client, {
        paymentId: payment.id,
        merchantId: payment.merchantId,
        fromState: rule.from,
        toState: rule.to,
        actor: rule.actor,
        source: 'worker',
        reason: 'settlement_confirmed',
        operationId: null,
        requestId: job.requestId,
      });
      await completeJob(client, work.jobId);
      return 'settled';
    },
  );

  if (outcome === 'wait') return reschedule(deps, work, job, 'poll_rescheduled');
  if (outcome === 'settled') {
    metricsOf(deps).transitions.inc({ from_state: 'captured', to_state: 'settled' });
    deps.logger.info(
      {
        event: 'payment.transitioned',
        paymentId: work.paymentId,
        jobId: work.jobId,
        fromState: 'captured',
        toState: 'settled',
      },
      'Payment transitioned',
    );
  } else if (outcome === 'lease_lost') {
    logLeaseLost(deps.logger, work);
  }
  return outcome;
}

/** An ordinary wait: due again after the poll interval, failure count reset to zero. */
async function reschedule(
  deps: SettlementDeps,
  work: SettlementWork,
  job: JobRecord,
  kind: 'poll_rescheduled',
): Promise<SettlementOutcome> {
  const outcome = await withTransaction(deps.pool, async (client): Promise<SettlementOutcome> => {
    const stop = await checkSettlementOwnership(client, work);
    if (stop) return stop;
    await rescheduleJob(client, {
      jobId: work.jobId,
      dueInMs: deps.pollIntervalMs,
      consecutiveFailures: 0,
      lastError: null,
    });
    return kind;
  });
  if (outcome === kind) {
    deps.logger.debug(
      { event: 'job.poll_rescheduled', attempt: job.attempts, delayMs: deps.pollIntervalMs },
      'Funds not available yet; checking again later',
    );
  } else if (outcome === 'lease_lost') {
    logLeaseLost(deps.logger, work);
  }
  return outcome;
}

async function retryOrPause(
  deps: SettlementDeps,
  work: SettlementWork,
  job: JobRecord,
  reason: 'provider_timeout' | 'provider_unavailable',
): Promise<SettlementOutcome> {
  const failures = job.consecutiveFailures + 1;
  if (failures > deps.maxRetries)
    return pause(deps, work, job, 'retries_exhausted', reason, failures);

  const delayMs = retryDelayMs(failures, deps.retryBaseMs, deps.random);
  const outcome = await withTransaction(deps.pool, async (client): Promise<SettlementOutcome> => {
    const stop = await checkSettlementOwnership(client, work);
    if (stop) return stop;
    await rescheduleJob(client, {
      jobId: work.jobId,
      dueInMs: delayMs,
      consecutiveFailures: failures,
      lastError: reason,
    });
    return 'retry_scheduled';
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
      'Settlement check failed; retry scheduled',
    );
  } else if (outcome === 'lease_lost') {
    logLeaseLost(deps.logger, work);
  }
  return outcome;
}

/** Payment → job: the payment stays captured and is flagged for settlement review; the job pauses. */
async function pause(
  deps: SettlementDeps,
  work: SettlementWork,
  job: JobRecord,
  reason: 'retries_exhausted' | 'review_deadline_reached',
  lastError: string | null,
  failures = job.consecutiveFailures,
): Promise<SettlementOutcome> {
  const outcome = await withTransaction(deps.pool, async (client): Promise<SettlementOutcome> => {
    const payment = await lockPayment(client, work.paymentId);
    if (!payment) throw new WorkMismatchError(`payment ${work.paymentId} does not exist`);
    const stop = await checkSettlementOwnership(client, work);
    if (stop) return stop;
    await flagSettlementReview(client, payment.id);
    await pauseJob(client, { jobId: work.jobId, reason, consecutiveFailures: failures, lastError });
    return 'paused';
  });
  if (outcome === 'paused') {
    deps.logger.error(
      { event: 'job.paused', attempt: job.attempts, consecutiveFailures: failures, reason },
      'Settlement paused for review',
    );
  } else if (outcome === 'lease_lost') {
    logLeaseLost(deps.logger, work);
  }
  return outcome;
}

/**
 * Locks the job and decides whether this run may still write: it must be the
 * payment's settlement job (else WorkMismatchError, rolling back), at this
 * run's lease generation (else lease_lost), and still running (else already_final).
 */
async function checkSettlementOwnership(
  client: PoolClient,
  work: SettlementWork,
): Promise<Stop | undefined> {
  const job = await lockJob(client, work.jobId);
  if (!job) throw new WorkMismatchError(`job ${work.jobId} does not exist`);
  assertSettlementJob(job, work.paymentId);
  if (job.leaseGeneration !== work.generation) return 'lease_lost';
  if (job.status !== 'running') return 'already_final';
  return undefined;
}

function assertSettlementJob(job: JobRecord, paymentId: PaymentRecord['id']): void {
  if (job.type !== 'settlement' || job.operationId !== null) {
    throw new WorkMismatchError(`job ${job.id} is not a settlement job`);
  }
  if (job.paymentId !== paymentId) {
    throw new WorkMismatchError(
      `job ${job.id} belongs to payment ${job.paymentId}, not ${paymentId}`,
    );
  }
}

function logLeaseLost(logger: Logger, work: SettlementWork): void {
  logger.warn(
    {
      event: 'job.lease_lost',
      paymentId: work.paymentId,
      jobId: work.jobId,
      generation: work.generation,
    },
    'Job lease no longer held; result discarded',
  );
}
