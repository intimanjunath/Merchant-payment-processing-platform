import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { JobRecord } from '@payments/db';
import {
  type Logger,
  parseTraceparent,
  runWithContext,
  startSpan,
  type TraceContext,
} from '@payments/observability';
import { claimJobs, type JobType } from '@payments/payments';
import type { Pool } from 'pg';

import type { Heartbeat } from './heartbeat';

/** What a handler knows about this run of a job, beyond the claimed row. */
export interface JobRun {
  workerRunId: string;
  owner: string;
  /** The lease generation this run holds; every write it makes is checked against it. */
  generation: number;
}

export type JobHandler = (job: JobRecord, run: JobRun) => Promise<void>;

export interface WorkerOptions {
  pool: Pool;
  logger: Logger;
  /** Lease owner name, unique per process. */
  owner: string;
  concurrency: number;
  pollIntervalMs: number;
  leaseSeconds: number;
  heartbeat: Heartbeat;
  /** Only job types with a handler are claimed. */
  handlers: Partial<Record<JobType, JobHandler>>;
}

/**
 * The span a worker run logs under. It continues the trace stored on the job
 * by the request that created it, so one trace ID finds the API request and
 * every later attempt; the run gets its own span ID, and the stored span is
 * logged as the one it follows from.
 */
export function workerSpan(job: JobRecord): {
  span: TraceContext;
  followsFrom: TraceContext | undefined;
} {
  const stored = parseTraceparent(job.traceparent ?? undefined);
  return { span: startSpan(stored), followsFrom: stored };
}

/**
 * Polls for due jobs and runs them, never claiming more than its free slots.
 * Each pass beats the heartbeat. stop() ends claiming at once and waits for
 * running jobs to finish; anything still running after the grace period is
 * left to lease expiry, so another worker recovers it.
 */
export class Worker {
  private running = false;
  private loop: Promise<void> | undefined;
  private readonly inFlight = new Set<Promise<void>>();
  private wake: (() => void) | undefined;

  constructor(private readonly options: WorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
    this.options.logger.info(
      { event: 'worker.started', owner: this.options.owner, concurrency: this.options.concurrency },
      'Worker started',
    );
  }

  /** Stops claiming; resolves once running jobs finish or the grace period ends. */
  async stop(graceMs: number): Promise<{ drained: boolean }> {
    this.running = false;
    this.wake?.();
    await this.loop;
    const drained = await Promise.race([
      Promise.allSettled([...this.inFlight]).then(() => true),
      sleep(graceMs).then(() => false),
    ]);
    this.options.logger.info(
      { event: 'worker.stopped', drained, unfinished: this.inFlight.size },
      drained
        ? 'Worker stopped'
        : 'Worker stopped; unfinished jobs will be recovered after lease expiry',
    );
    return { drained };
  }

  get activeJobs(): number {
    return this.inFlight.size;
  }

  private async run(): Promise<void> {
    const types = Object.keys(this.options.handlers) as JobType[];
    while (this.running) {
      this.options.heartbeat.beat();
      const freeSlots = this.options.concurrency - this.inFlight.size;
      if (freeSlots > 0) {
        for (const job of await this.claim(freeSlots, types)) this.track(this.execute(job));
      }
      await this.pause();
    }
  }

  private async claim(freeSlots: number, types: JobType[]): Promise<JobRecord[]> {
    try {
      return await claimJobs(this.options.pool, {
        owner: this.options.owner,
        freeSlots,
        leaseSeconds: this.options.leaseSeconds,
        types,
      });
    } catch (error) {
      this.options.logger.warn(
        { event: 'worker.claim_failed', err: error },
        'Could not claim jobs',
      );
      return [];
    }
  }

  /** Until the poll interval passes, a job finishes (freeing a slot), or stop() is called. */
  private async pause(): Promise<void> {
    const stopped = new Promise<void>((resolve) => {
      this.wake = resolve;
    });
    await Promise.race([sleep(this.options.pollIntervalMs), stopped, ...this.inFlight]);
    this.wake = undefined;
  }

  private track(work: Promise<void>): void {
    const tracked = work.finally(() => this.inFlight.delete(tracked));
    this.inFlight.add(tracked);
  }

  private execute(job: JobRecord): Promise<void> {
    const handler = this.options.handlers[job.type];
    const run: JobRun = {
      workerRunId: randomUUID(),
      owner: this.options.owner,
      generation: job.leaseGeneration,
    };
    const { span, followsFrom } = workerSpan(job);
    const context = {
      requestId: job.requestId,
      workerRunId: run.workerRunId,
      jobId: job.id,
      paymentId: job.paymentId,
      traceId: span.traceId,
      spanId: span.spanId,
      ...(job.operationId ? { operationId: job.operationId } : {}),
    };

    return runWithContext(context, async () => {
      const { logger } = this.options;
      logger.debug(
        {
          event: 'job.claimed',
          type: job.type,
          attempt: job.attempts,
          generation: job.leaseGeneration,
          followsFromSpanId: followsFrom?.spanId,
        },
        'Job claimed',
      );
      try {
        if (!handler) throw new Error(`No handler for job type ${job.type}`);
        await handler(job, run);
      } catch (error) {
        // The job keeps its lease; once it expires, it is claimed again.
        logger.error(
          { event: 'job.failed', type: job.type, attempt: job.attempts, err: error },
          'Job handler failed; it will be retried after the lease expires',
        );
      }
    });
  }
}
