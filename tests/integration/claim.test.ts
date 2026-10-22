import { createPool } from '@payments/db';
import { claimJobs, JOB_TYPES, type JobType, renewJobLease } from '@payments/payments';
import type { Pool } from 'pg';

import { insertJob, jobRow } from '../helpers/jobs';
import { createScratchDatabase } from '../helpers/test-db';

describe('claiming jobs', () => {
  let scratch: { url: string; drop: () => Promise<void> };
  let pool: Pool;

  beforeAll(async () => {
    scratch = await createScratchDatabase({ seed: true });
    pool = createPool(scratch.url, { applicationName: 'claim-test', max: 12 });
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM jobs');
  });

  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  const claim = (owner: string, freeSlots = 10, types: readonly JobType[] = JOB_TYPES) =>
    claimJobs(pool, { owner, freeSlots, leaseSeconds: 30, types });

  it('claims due queued jobs and expired running ones, and nothing else', async () => {
    const due = await insertJob(pool, { status: 'queued', dueInMs: -1_000 });
    const expired = await insertJob(pool, {
      status: 'running',
      leaseEndsInMs: -1_000,
      generation: 3,
    });
    await insertJob(pool, { status: 'queued', dueInMs: 60_000 });
    await insertJob(pool, { status: 'running', leaseEndsInMs: 30_000 });
    await insertJob(pool, { status: 'paused' });
    await insertJob(pool, { status: 'completed' });
    await insertJob(pool, { status: 'cancelled' });

    const claimed = await claim('worker:A');

    expect(claimed.map((job) => job.id).sort()).toEqual([due.jobId, expired.jobId].sort());
    expect(await jobRow(pool, due.jobId)).toMatchObject({
      status: 'running',
      lease_owner: 'worker:A',
      lease_generation: '1',
      attempts: 1,
    });
    expect(await jobRow(pool, expired.jobId)).toMatchObject({
      lease_owner: 'worker:A',
      lease_generation: '4',
    });
    for (const job of claimed) {
      expect((job.leaseExpiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(25_000);
    }
  });

  it('claims no more than the free slots, and nothing with none free', async () => {
    for (let i = 0; i < 5; i += 1) await insertJob(pool);

    expect(await claim('worker:A', 2)).toHaveLength(2);
    expect(await claim('worker:A', 0)).toHaveLength(0);
    expect(await claim('worker:A', 10)).toHaveLength(3);
  });

  it('claims only the types asked for', async () => {
    const settlement = await insertJob(pool, { type: 'settlement' });
    await insertJob(pool, { type: 'operation_recovery' });

    expect((await claim('worker:A', 10, ['settlement'])).map((job) => job.id)).toEqual([
      settlement.jobId,
    ]);
  });

  it('never gives one job to two concurrent claimers', async () => {
    const ids = [];
    for (let i = 0; i < 40; i += 1) ids.push((await insertJob(pool)).jobId);

    // Ten claimers, one slot each, racing until nothing is left.
    const owners = Array.from({ length: 10 }, (_, i) => `worker:${String(i)}`);
    const taken = await Promise.all(
      owners.map(async (owner) => {
        const mine: string[] = [];
        for (;;) {
          const [job] = await claim(owner, 1);
          if (!job) return mine;
          mine.push(job.id);
        }
      }),
    );

    const all = taken.flat();
    expect(all.sort()).toEqual([...ids].sort());
    expect(new Set(all).size).toBe(all.length);
    expect(taken.filter((mine) => mine.length > 0).length).toBeGreaterThan(1);
  });

  it('renews the lease only for the generation that holds it', async () => {
    await insertJob(pool);
    const [job] = await claim('worker:A', 1);
    if (!job) throw new Error('expected a claim');

    expect(await renewJobLease(pool, { jobId: job.id, generation: job.leaseGeneration }, 30)).toBe(
      true,
    );
    expect(
      await renewJobLease(pool, { jobId: job.id, generation: job.leaseGeneration - 1 }, 30),
    ).toBe(false);

    await pool.query(
      `UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [job.id],
    );
    const [takenOver] = await claim('worker:B', 1);
    expect(takenOver?.leaseGeneration).toBe(job.leaseGeneration + 1);
    expect(await renewJobLease(pool, { jobId: job.id, generation: job.leaseGeneration }, 30)).toBe(
      false,
    );
  });
});
