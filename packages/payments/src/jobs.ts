import { claimDueJobs, type JobRecord, renewLease } from '@payments/db';
import type { Pool } from 'pg';

export const JOB_TYPES = ['operation_recovery', 'settlement'] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Claims due work for one owner, at most as many jobs as it has free slots,
 * so a claimed job never waits locally while its lease runs down. Only the
 * types the caller can handle are claimed.
 */
export function claimJobs(
  pool: Pool,
  claim: { owner: string; freeSlots: number; leaseSeconds: number; types: readonly JobType[] },
): Promise<JobRecord[]> {
  if (claim.freeSlots < 1 || claim.types.length === 0) return Promise.resolve([]);
  return claimDueJobs(pool, {
    owner: claim.owner,
    limit: claim.freeSlots,
    leaseSeconds: claim.leaseSeconds,
    types: claim.types,
  });
}

/**
 * Called before each provider call. False means another owner took the job
 * over (the lease expired and it was claimed again): stop, and don't call.
 */
export function renewJobLease(
  pool: Pool,
  job: { jobId: string; generation: number },
  leaseSeconds: number,
): Promise<boolean> {
  return renewLease(pool, { jobId: job.jobId, generation: job.generation, leaseSeconds });
}
