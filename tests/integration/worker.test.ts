import type { Server } from 'node:http';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import { createPool, type JobRecord } from '@payments/db';
import { createLogger, createMetricsRegistry, getContext } from '@payments/observability';
import type { Pool } from 'pg';
import request from 'supertest';

import { createHealthServer } from '../../apps/worker/src/health';
import { Heartbeat } from '../../apps/worker/src/heartbeat';
import { type JobHandler, Worker } from '../../apps/worker/src/worker';
import { insertJob, jobRow } from '../helpers/jobs';
import { createScratchDatabase } from '../helpers/test-db';

const POLL_MS = 50;
const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
const STORED_TRACEPARENT = `00-${TRACE_ID}-00f067aa0ba902b7-01`;

describe('worker', () => {
  let scratch: { url: string; drop: () => Promise<void> };
  let pool: Pool;
  let logs: Record<string, unknown>[];

  beforeAll(async () => {
    scratch = await createScratchDatabase({ seed: true });
    pool = createPool(scratch.url, { applicationName: 'worker-test', max: 6 });
  });

  // Every worker and gate a test creates, so a failing test can't leave one running.
  const started: Worker[] = [];
  const gates: (() => void)[] = [];

  beforeEach(async () => {
    logs = [];
    await pool.query('DELETE FROM jobs');
  });

  afterEach(async () => {
    for (const release of gates.splice(0)) release();
    await Promise.all(started.splice(0).map((worker) => worker.stop(100)));
  });

  afterAll(async () => {
    await pool.end();
    await scratch.drop();
  });

  function logger() {
    return createLogger({
      service: 'worker',
      level: 'debug',
      destination: new Writable({
        write(chunk: Buffer, _encoding, done) {
          logs.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
          done();
        },
      }),
    });
  }

  function newWorker(
    handlers: Partial<Record<JobRecord['type'], JobHandler>>,
    concurrency = 1,
    on: Pool = pool,
  ) {
    const heartbeat = new Heartbeat(createMetricsRegistry('worker'), 1_000);
    const worker = new Worker({
      pool: on,
      logger: logger(),
      owner: 'worker:test',
      concurrency,
      pollIntervalMs: POLL_MS,
      leaseSeconds: 30,
      heartbeat,
      handlers,
    });
    started.push(worker);
    return { worker, heartbeat };
  }

  /** A handler that runs until released, recording which jobs it saw. */
  function gatedHandler() {
    const seen: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    gates.push(() => {
      release();
    });
    const handler: JobHandler = async (job) => {
      seen.push(job.id);
      await gate;
    };
    return {
      handler,
      seen,
      release: () => {
        release();
      },
    };
  }

  async function until(
    condition: () => Promise<boolean> | boolean,
    timeoutMs = 3_000,
  ): Promise<void> {
    const started = Date.now();
    while (!(await condition())) {
      if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
      await sleep(10);
    }
  }

  it('runs a job under its original request ID, its own run ID, and the stored trace', async () => {
    const { jobId } = await insertJob(pool, {
      requestId: 'req-original',
      traceparent: STORED_TRACEPARENT,
    });
    let context: ReturnType<typeof getContext>;
    const { worker } = newWorker({
      operation_recovery: async (_job, run) => {
        context = getContext();
        logger().info({ event: 'test.inside_job', workerRunId: run.workerRunId }, 'inside');
        await pool.query(
          `UPDATE jobs SET status = 'completed', lease_owner = NULL, lease_expires_at = NULL,
                            completed_at = now() WHERE id = $1`,
          [jobId],
        );
      },
    });

    worker.start();
    await until(async () => (await jobRow(pool, jobId))?.status === 'completed');
    await worker.stop(1_000);

    expect(context).toMatchObject({ requestId: 'req-original', jobId, traceId: TRACE_ID });
    expect(context?.workerRunId).toEqual(expect.any(String));
    expect(context?.spanId).not.toBe('00f067aa0ba902b7');
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'job.claimed',
        requestId: 'req-original',
        workerRunId: context?.workerRunId,
        traceId: TRACE_ID,
        followsFromSpanId: '00f067aa0ba902b7',
        attempt: 1,
        generation: 1,
      }),
    );
  });

  it('never runs more jobs at once than its concurrency', async () => {
    const first = await insertJob(pool);
    const second = await insertJob(pool);
    const gated = gatedHandler();
    const { worker } = newWorker({ operation_recovery: gated.handler }, 1);

    worker.start();
    await until(() => gated.seen.length === 1);
    await sleep(POLL_MS * 4);

    // One slot: the other job was not claimed while the first ran.
    expect(gated.seen).toHaveLength(1);
    const statuses = [
      (await jobRow(pool, first.jobId))?.status,
      (await jobRow(pool, second.jobId))?.status,
    ];
    expect(statuses.sort()).toEqual(['queued', 'running']);

    gated.release();
    await until(() => gated.seen.length === 2);
    await worker.stop(1_000);
  });

  it('claims only the job types it has handlers for', async () => {
    const recovery = await insertJob(pool, { type: 'operation_recovery' });
    const settlement = await insertJob(pool, { type: 'settlement' });
    const gated = gatedHandler();
    const { worker } = newWorker({ settlement: gated.handler });

    worker.start();
    await until(() => gated.seen.length === 1);
    gated.release();
    await worker.stop(1_000);

    expect(gated.seen).toEqual([settlement.jobId]);
    expect((await jobRow(pool, recovery.jobId))?.status).toBe('queued');
  });

  it('stops claiming at once on stop() and drains the running job', async () => {
    const { jobId } = await insertJob(pool);
    let finished = false;
    const { worker } = newWorker({
      operation_recovery: async () => {
        await sleep(300);
        finished = true;
      },
    });
    worker.start();
    await until(async () => (await jobRow(pool, jobId))?.status === 'running');

    const stopping = worker.stop(5_000);
    const late = await insertJob(pool);
    const result = await stopping;
    await sleep(POLL_MS * 4);

    expect(result).toEqual({ drained: true });
    expect(finished).toBe(true);
    expect((await jobRow(pool, late.jobId))?.status).toBe('queued');
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'worker.stopped', drained: true }),
    );
  });

  it('gives up waiting after the grace period, leaving the job to lease expiry', async () => {
    const { jobId } = await insertJob(pool);
    const gated = gatedHandler();
    const { worker } = newWorker({ operation_recovery: gated.handler });
    worker.start();
    await until(() => gated.seen.length === 1);

    const result = await worker.stop(100);

    expect(result).toEqual({ drained: false });
    expect(await jobRow(pool, jobId)).toMatchObject({
      status: 'running',
      lease_owner: 'worker:test',
    });
    gated.release();
  });

  it('logs a failing handler and leaves the job leased for a later retry', async () => {
    const { jobId } = await insertJob(pool);
    const { worker } = newWorker({
      operation_recovery: () => Promise.reject(new Error('handler blew up')),
    });

    worker.start();
    await until(() => logs.some((line) => line.event === 'job.failed'));
    await worker.stop(1_000);

    expect(await jobRow(pool, jobId)).toMatchObject({
      status: 'running',
      lease_owner: 'worker:test',
    });
  });

  it('keeps polling, and beating, when claiming fails', async () => {
    const broken = createPool(scratch.url, { applicationName: 'worker-broken', max: 1 });
    await broken.end();
    const { worker, heartbeat } = newWorker(
      { operation_recovery: () => Promise.resolve() },
      1,
      broken,
    );
    const before = heartbeat.lastBeatAt.getTime();

    worker.start();
    await until(() => logs.filter((line) => line.event === 'worker.claim_failed').length >= 2);
    await worker.stop(100);

    expect(heartbeat.lastBeatAt.getTime()).toBeGreaterThan(before);
  });

  describe('health server', () => {
    let server: Server;
    let shuttingDown: boolean;
    let now: number;
    let heartbeat: Heartbeat;

    beforeEach(() => {
      shuttingDown = false;
      now = Date.now();
      const metrics = createMetricsRegistry('worker');
      heartbeat = new Heartbeat(metrics, 10_000, () => now);
      server = createHealthServer({
        pool,
        logger: logger(),
        metrics,
        heartbeat,
        readinessTimeoutMs: 1_000,
        isShuttingDown: () => shuttingDown,
      });
    });

    it('reports health from the heartbeat: ok within 30 s, 503 after', async () => {
      const fresh = await request(server).get('/health').expect(200);
      now += 31_000;
      const stale = await request(server).get('/health').expect(503);

      expect(fresh.body).toEqual({
        status: 'ok',
        lastHeartbeatAt: new Date(now - 31_000).toISOString(),
      });
      expect(stale.body.status).toBe('stale');
      expect(fresh.headers['x-request-id']).toEqual(expect.any(String));
    });

    it('is ready with the database up, and not ready once shutting down', async () => {
      const ready = await request(server).get('/ready').expect(200);
      shuttingDown = true;
      const stopping = await request(server).get('/ready').expect(503);

      expect(ready.body).toEqual({
        status: 'ready',
        checks: { database: 'ok', migrations: 'ok' },
        shuttingDown: false,
      });
      expect(stopping.body).toMatchObject({ status: 'not_ready', shuttingDown: true });
    });

    it('is not ready when the database is unreachable', async () => {
      const down = createPool('postgres://nobody:nothing@127.0.0.1:1/none', {
        applicationName: 'down',
        max: 1,
      });
      const unreachable = createHealthServer({
        pool: down,
        logger: logger(),
        metrics: createMetricsRegistry('worker'),
        heartbeat,
        readinessTimeoutMs: 500,
        isShuttingDown: () => false,
      });
      try {
        const res = await request(unreachable).get('/ready').expect(503);
        expect(res.body.checks).toEqual({ database: 'unavailable', migrations: 'unknown' });
      } finally {
        await down.end();
      }
    });

    it('serves metrics, including request counts and the heartbeat', async () => {
      await request(server).get('/health');
      const res = await request(server).get('/metrics').expect(200);

      expect(res.text).toMatch(/http_requests_total\{[^}]*route="\/health"[^}]*\} 1/);
      expect(res.text).toMatch(/worker_heartbeat_timestamp_seconds\{[^}]*\} \d+/);
    });

    it('answers anything else with a 404 envelope, under a bounded route label', async () => {
      const res = await request(server).get('/payments/123').expect(404);
      const metrics = await request(server).get('/metrics');

      expect(res.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
      expect(metrics.text).toMatch(/route="unmatched"/);
      expect(metrics.text).not.toContain('/payments/123');
    });
  });
});
