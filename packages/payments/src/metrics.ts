import { createPaymentMetrics, type PaymentMetrics, Registry } from '@payments/observability';

import type { FinalizeResult, ScheduleResult } from './finalize';
import type { RecoveryOutcome } from './recovery';
import type { SettlementOutcome } from './settlement';

// Callers that pass no metrics (most tests) record into a private registry nobody reads.
const UNREAD = createPaymentMetrics(new Registry());

export function metricsOf(deps: { metrics?: PaymentMetrics | undefined }): PaymentMetrics {
  return deps.metrics ?? UNREAD;
}

type JobResult =
  'completed' | 'rescheduled' | 'retried' | 'paused' | 'lease_lost' | 'version_conflict' | 'failed';

/** Every outcome a job run can end with, plus `failed` for an attempt that threw. */
export type JobRunOutcome =
  RecoveryOutcome | SettlementOutcome | FinalizeResult['kind'] | ScheduleResult['kind'] | 'failed';

// How each outcome is counted. Typed over every outcome, so a new one that is
// left out is a compile error rather than a run that silently goes uncounted.
const RESULTS: Readonly<Record<JobRunOutcome, JobResult>> = {
  finalized: 'completed',
  settled: 'completed',
  not_applicable: 'completed',
  // Someone already finished the work (a duplicate or late run): the job is done.
  already_final: 'completed',
  scheduled: 'rescheduled',
  poll_rescheduled: 'rescheduled',
  retry_scheduled: 'retried',
  paused: 'paused',
  lease_lost: 'lease_lost',
  version_conflict: 'version_conflict',
  // The attempt threw. Only the fact is counted: no error message or class becomes a label.
  failed: 'failed',
};

type JobType = 'operation_recovery' | 'settlement';

/** Counts one job run by its outcome. */
export function countJobRun(
  deps: { metrics?: PaymentMetrics | undefined },
  type: JobType,
  outcome: JobRunOutcome,
): void {
  metricsOf(deps).jobRuns.inc({ type, result: RESULTS[outcome] });
}

/**
 * A counter for one run that counts exactly once: a run that already recorded
 * its result is not counted again as failed if something throws afterwards.
 */
export function countJobRunOnce(
  deps: { metrics?: PaymentMetrics | undefined },
  type: JobType,
): (outcome: JobRunOutcome) => void {
  let counted = false;
  return (outcome) => {
    if (counted) return;
    counted = true;
    countJobRun(deps, type, outcome);
  };
}

/** Runs one job attempt, counting it as failed (then rethrowing) if it throws. */
export async function countingFailures<T>(
  deps: { metrics?: PaymentMetrics | undefined },
  type: JobType,
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    countJobRun(deps, type, 'failed');
    throw error;
  }
}
