import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { createPool } from '@payments/db';
import { createLogger, createMetricsRegistry, createPaymentMetrics } from '@payments/observability';
import {
  capturePayment,
  claimJobs,
  createPayment,
  type PaymentDeps,
  recoverOperation,
  type RecoveryDeps,
  type SettlementDeps,
  settlePayment,
} from '@payments/payments';
import { createFakeProvider } from '@payments/provider';
import type { Pool } from 'pg';
import request from 'supertest';

import { registerStateCollector } from '../../apps/worker/src/collector';
import { recoveryHandler } from '../../apps/worker/src/handlers/recovery';
import { Heartbeat } from '../../apps/worker/src/heartbeat';
import { Worker } from '../../apps/worker/src/worker';
import {
  clearLoginAttempts,
  migrateTestDatabase,
  SEEDED_MERCHANTS,
  startTestApi,
  type TestApi,
} from '../helpers/api';
import { parseMetrics, valueOf } from '../helpers/metrics';
import { wrapProvider } from '../helpers/provider';
import { createScratchDatabase } from '../helpers/test-db';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('metrics', () => {
  describe('API', () => {
    let api: TestApi;
    let token: string;

    beforeAll(async () => {
      await migrateTestDatabase({ seed: true });
      await clearLoginAttempts();
      api = await startTestApi({ poolMax: 4 });
      const login = await request(api.app.getHttpServer())
        .post('/auth/token')
        .send({ email: SEEDED_MERCHANTS.acme.email, password: SEEDED_MERCHANTS.acme.password })
        .expect(200);
      token = String(login.body.accessToken);
    });

    afterAll(async () => {
      await api.app.close();
    });

    const post = (path: string, body: object, key = `key-${randomUUID()}`) =>
      request(api.app.getHttpServer())
        .post(path)
        .set('Authorization', `Bearer ${token}`)
        .set('Idempotency-Key', key)
        .send(body);
    const order = (paymentMethod: string) => ({
      amount: 1500,
      reference: `metrics-${randomUUID()}`,
      paymentMethod,
    });

    it('counts transitions, idempotency, provider calls and job runs from a scenario', async () => {
      const key = `key-${randomUUID()}`;
      const visa = order('pm_card_visa');
      const approved = await post('/payments', visa, key).expect(201);
      await post('/payments', visa, key).expect(201); // replay
      await post('/payments', { ...visa, amount: 1600 }, key).expect(409); // conflict
      await post('/payments', order('pm_card_declined')).expect(201);
      await post('/payments', order('pm_timeout')).expect(202);
      await post(`/payments/${String(approved.body.payment.id)}/capture`, {}).expect(200);

      const text = (await request(api.app.getHttpServer()).get('/metrics').expect(200)).text;
      const samples = parseMetrics(text);
      const value = (name: string, labels: Record<string, string>) =>
        valueOf(samples, name, labels);

      expect({
        created: value('payment_transitions_total', { from_state: 'none', to_state: 'pending' }),
        authorized: value('payment_transitions_total', {
          from_state: 'pending',
          to_state: 'authorized',
        }),
        failed: value('payment_transitions_total', { from_state: 'pending', to_state: 'failed' }),
        captured: value('payment_transitions_total', {
          from_state: 'authorized',
          to_state: 'captured',
        }),
        replays: value('idempotency_replays_total', { action: 'authorize' }),
        conflicts: value('idempotency_conflicts_total', { action: 'authorize' }),
        authorizeOk: value('provider_requests_total', {
          operation: 'authorize',
          outcome: 'succeeded',
        }),
        authorizeRejected: value('provider_requests_total', {
          operation: 'authorize',
          outcome: 'rejected',
        }),
        authorizeTimeout: value('provider_requests_total', {
          operation: 'authorize',
          outcome: 'timeout',
        }),
        captureOk: value('provider_requests_total', { operation: 'capture', outcome: 'succeeded' }),
        authorizeTimings: value('provider_request_duration_seconds_count', {
          operation: 'authorize',
        }),
        jobsCompleted: value('job_runs_total', { type: 'operation_recovery', result: 'completed' }),
        jobsRescheduled: value('job_runs_total', {
          type: 'operation_recovery',
          result: 'rescheduled',
        }),
      }).toEqual({
        created: 3,
        authorized: 1,
        failed: 1,
        captured: 1,
        replays: 1,
        conflicts: 1,
        authorizeOk: 1,
        authorizeRejected: 1,
        authorizeTimeout: 1,
        captureOk: 1,
        authorizeTimings: 3,
        jobsCompleted: 3,
        jobsRescheduled: 1,
      });
      expect(samples.every((sample) => sample.labels.service === 'api')).toBe(true);
      // Labels stay bounded: no payment, merchant or operation IDs, no references.
      expect(text).not.toMatch(UUID);
      expect(text).not.toContain('metrics-');
      // Database-wide gauges come from the worker only.
      expect(text).not.toContain('payments_by_state');
    });
  });

  describe('worker', () => {
    let scratch: { url: string; drop: () => Promise<void> };
    let pool: Pool;
    let merchantId: string;
    const logs: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'worker',
      level: 'debug',
      destination: new Writable({
        write(chunk: Buffer, _encoding, done) {
          logs.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
          done();
        },
      }),
    });

    beforeAll(async () => {
      scratch = await createScratchDatabase({ seed: true });
      pool = createPool(scratch.url, { applicationName: 'metrics-test', max: 6 });
      const merchant = await pool.query<{ id: string }>(
        'SELECT id FROM merchants WHERE email = $1',
        [SEEDED_MERCHANTS.acme.email],
      );
      merchantId = merchant.rows[0]?.id ?? '';
    });

    afterAll(async () => {
      await pool.end();
      await scratch.drop();
    });

    const provider = () => createFakeProvider(pool, { timeoutMs: 100, settlementDelayMs: 60_000 });
    const apiDeps = (): PaymentDeps => ({
      pool,
      logger,
      provider: provider(),
      source: 'api',
      leaseOwner: 'api:test',
      leaseSeconds: 30,
      reviewDeadlineSeconds: 1_800,
      settlementPollMs: 60_000,
      recoveryDelayMs: 0,
    });
    const create = (paymentMethod: string) =>
      createPayment(
        apiDeps(),
        {
          merchantId,
          idempotencyKey: `key-${randomUUID()}`,
          requestId: 'req-metrics',
          traceparent: null,
        },
        { amount: 1500, reference: `metrics-${randomUUID()}`, paymentMethod },
      );

    it('counts the worker’s own transitions, provider calls and job runs', async () => {
      await create('pm_timeout');
      const registry = createMetricsRegistry('worker');
      const deps: RecoveryDeps = {
        pool,
        logger,
        provider: provider(),
        source: 'worker',
        leaseSeconds: 30,
        maxRetries: 3,
        retryBaseMs: 1_000,
        reviewDeadlineSeconds: 1_800,
        settlementPollMs: 60_000,
        metrics: createPaymentMetrics(registry),
      };
      const [job] = await claimJobs(pool, {
        owner: 'worker:test',
        freeSlots: 1,
        leaseSeconds: 30,
        types: ['operation_recovery'],
      });
      if (!job) throw new Error('expected a due recovery job');

      expect(await recoverOperation(deps, job, { generation: job.leaseGeneration })).toBe(
        'finalized',
      );

      const samples = parseMetrics(await registry.metrics());
      expect(
        valueOf(samples, 'payment_transitions_total', {
          from_state: 'pending',
          to_state: 'failed',
        }),
      ).toBe(1);
      expect(
        valueOf(samples, 'provider_requests_total', { operation: 'lookup', outcome: 'succeeded' }),
      ).toBe(1);
      expect(
        valueOf(samples, 'job_runs_total', { type: 'operation_recovery', result: 'completed' }),
      ).toBe(1);
    });

    describe('counting job runs', () => {
      const jobRuns = (text: string) =>
        parseMetrics(text).filter((sample) => sample.name === 'job_runs_total');
      const failedRuns = (text: string, type: string) =>
        valueOf(parseMetrics(text), 'job_runs_total', { type, result: 'failed' });
      const failing = (call: string) => new Error(`${call} exploded: secret-detail`);

      function recoveryDeps(
        registry: ReturnType<typeof createMetricsRegistry>,
        lookup: () => Promise<never>,
      ): RecoveryDeps {
        return {
          pool,
          logger,
          provider: wrapProvider(provider(), { lookup }),
          source: 'worker',
          leaseSeconds: 30,
          maxRetries: 3,
          retryBaseMs: 1_000,
          reviewDeadlineSeconds: 1_800,
          settlementPollMs: 60_000,
          metrics: createPaymentMetrics(registry),
        };
      }

      async function claimOne(type: 'operation_recovery' | 'settlement') {
        await pool.query(`UPDATE jobs SET due_at = now() WHERE status = 'queued' AND type = $1`, [
          type,
        ]);
        const [job] = await claimJobs(pool, {
          owner: 'worker:test',
          freeSlots: 1,
          leaseSeconds: 30,
          types: [type],
        });
        if (!job) throw new Error(`expected a due ${type} job`);
        return job;
      }

      beforeEach(async () => {
        await pool.query(`UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
                           WHERE status IN ('queued', 'running')`);
      });

      it('counts a run that finds the work already finished as completed, exactly once', async () => {
        await create('pm_timeout');
        const job = await claimOne('operation_recovery');
        // Someone else resolved the operation while this job was claimed (a duplicate or late run).
        await pool.query(
          `UPDATE operations SET status = 'rejected', reason = 'authorization_not_received', completed_at = now()
            WHERE id = $1`,
          [job.operationId],
        );
        const registry = createMetricsRegistry('worker');
        const deps = {
          ...recoveryDeps(registry, () => Promise.reject(new Error('unused'))),
          provider: provider(),
        };

        expect(await recoverOperation(deps, job, { generation: job.leaseGeneration })).toBe(
          'already_final',
        );

        const text = await registry.metrics();
        expect(
          valueOf(parseMetrics(text), 'job_runs_total', {
            type: 'operation_recovery',
            result: 'completed',
          }),
        ).toBe(1);
        expect(jobRuns(text).reduce((sum, sample) => sum + sample.value, 0)).toBe(1);
      });

      it('counts a recovery attempt that throws as failed, once, and rethrows the same error', async () => {
        await create('pm_timeout');
        const job = await claimOne('operation_recovery');
        const registry = createMetricsRegistry('worker');
        const error = failing('lookup');

        await expect(
          recoverOperation(
            recoveryDeps(registry, () => Promise.reject(error)),
            job,
            { generation: job.leaseGeneration },
          ),
        ).rejects.toBe(error);

        const text = await registry.metrics();
        expect(failedRuns(text, 'operation_recovery')).toBe(1);
        expect(jobRuns(text).reduce((sum, sample) => sum + sample.value, 0)).toBe(1);
        expect(text).not.toContain('exploded');
        expect(text).not.toContain('secret-detail');
      });

      it('counts a settlement attempt that throws as failed, once, and rethrows the same error', async () => {
        const created = await create('pm_card_visa');
        await capturePayment(
          apiDeps(),
          {
            merchantId,
            idempotencyKey: `key-${randomUUID()}`,
            requestId: 'req-metrics',
            traceparent: null,
          },
          { paymentId: (created.body as { payment: { id: string } }).payment.id },
        );
        const job = await claimOne('settlement');
        const registry = createMetricsRegistry('worker');
        const error = failing('getSettlement');
        const deps: SettlementDeps = {
          pool,
          logger,
          provider: { getSettlement: () => Promise.reject(error) },
          leaseSeconds: 30,
          pollIntervalMs: 60_000,
          maxRetries: 3,
          retryBaseMs: 1_000,
          metrics: createPaymentMetrics(registry),
        };

        await expect(settlePayment(deps, job, { generation: job.leaseGeneration })).rejects.toBe(
          error,
        );

        const text = await registry.metrics();
        expect(failedRuns(text, 'settlement')).toBe(1);
        expect(jobRuns(text).reduce((sum, sample) => sum + sample.value, 0)).toBe(1);
        expect(text).not.toContain('exploded');
      });

      it('counts an API-owned run that throws as failed exactly once', async () => {
        const registry = createMetricsRegistry('api');
        const error = failing('authorize');
        const deps: PaymentDeps = {
          ...apiDeps(),
          provider: wrapProvider(provider(), { authorize: () => Promise.reject(error) }),
          metrics: createPaymentMetrics(registry),
        };

        await expect(
          createPayment(
            deps,
            {
              merchantId,
              idempotencyKey: `key-${randomUUID()}`,
              requestId: 'req-metrics',
              traceparent: null,
            },
            { amount: 1500, reference: `metrics-${randomUUID()}`, paymentMethod: 'pm_card_visa' },
          ),
        ).rejects.toBe(error);

        const text = await registry.metrics();
        expect(failedRuns(text, 'operation_recovery')).toBe(1);
        expect(jobRuns(text).reduce((sum, sample) => sum + sample.value, 0)).toBe(1);
        expect(text).not.toContain('exploded');
      });

      it('does not count an API-owned run twice when it throws after recording its result', async () => {
        const registry = createMetricsRegistry('api');
        // Transactions (reservation, rescheduling) work; the final direct read of the stored state fails.
        const readFails = {
          connect: () => pool.connect(),
          query: () => Promise.reject(new Error('read failed')),
        } as unknown as Pool;
        const deps: PaymentDeps = {
          ...apiDeps(),
          pool: readFails,
          metrics: createPaymentMetrics(registry),
        };

        await expect(
          createPayment(
            deps,
            {
              merchantId,
              idempotencyKey: `key-${randomUUID()}`,
              requestId: 'req-metrics',
              traceparent: null,
            },
            { amount: 1500, reference: `metrics-${randomUUID()}`, paymentMethod: 'pm_timeout' },
          ),
        ).rejects.toThrow('read failed');

        const text = await registry.metrics();
        expect(
          valueOf(parseMetrics(text), 'job_runs_total', {
            type: 'operation_recovery',
            result: 'rescheduled',
          }),
        ).toBe(1);
        expect(failedRuns(text, 'operation_recovery')).toBeUndefined();
        expect(jobRuns(text).reduce((sum, sample) => sum + sample.value, 0)).toBe(1);
      });

      it('counts a worker-owned run that throws exactly once, with the worker still logging job.failed', async () => {
        await create('pm_timeout');
        await pool.query(`UPDATE jobs SET due_at = now() WHERE status = 'queued'`);
        const registry = createMetricsRegistry('worker');
        const worker = new Worker({
          pool,
          logger,
          owner: 'worker:metrics',
          concurrency: 1,
          pollIntervalMs: 50,
          leaseSeconds: 30,
          heartbeat: new Heartbeat(registry, 1_000),
          handlers: {
            operation_recovery: recoveryHandler(
              recoveryDeps(registry, () => Promise.reject(failing('lookup'))),
            ),
          },
        });
        logs.length = 0;

        worker.start();
        try {
          for (let i = 0; i < 100 && !logs.some((line) => line.event === 'job.failed'); i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } finally {
          await worker.stop(1_000);
        }

        const text = await registry.metrics();
        expect(logs.filter((line) => line.event === 'job.failed')).toHaveLength(1);
        expect(failedRuns(text, 'operation_recovery')).toBe(1);
        expect(jobRuns(text).reduce((sum, sample) => sum + sample.value, 0)).toBe(1);
      });
    });

    it('reports database-wide state from one query per scrape, every label present', async () => {
      await pool.query(`UPDATE jobs SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
                         WHERE status IN ('queued', 'running')`);
      await create('pm_card_visa'); // authorized
      await create('pm_timeout'); // pending, awaiting, its job due now (recoveryDelayMs 0)
      const paused = await create('pm_timeout');
      await pool.query(
        `UPDATE jobs SET status = 'paused', paused_reason = 'retries_exhausted'
                         WHERE payment_id = $1`,
        [(paused.body as { payment: { id: string } }).payment.id],
      );
      await pool.query(`UPDATE operations SET created_at = now() - interval '2 minutes'
                         WHERE status IN ('reserved', 'awaiting_confirmation', 'needs_review')`);

      let queries = 0;
      const counting = {
        query: (sql: string, params?: unknown[]) => {
          queries += 1;
          return pool.query(sql, params);
        },
      } as unknown as Pool;
      const registry = createMetricsRegistry('worker');
      registerStateCollector(registry, counting, logger);

      const samples = parseMetrics(await registry.metrics());

      expect(queries).toBe(1);
      const byState = await pool.query<{ state: string; n: number }>(
        'SELECT state, count(*)::int AS n FROM payments GROUP BY state',
      );
      for (const state of ['pending', 'authorized', 'captured', 'settled', 'failed', 'refunded']) {
        expect(valueOf(samples, 'payments_by_state', { state })).toBe(
          byState.rows.find((row) => row.state === state)?.n ?? 0,
        );
      }
      expect(valueOf(samples, 'jobs_due', { type: 'operation_recovery' })).toBe(1);
      expect(valueOf(samples, 'jobs_due', { type: 'settlement' })).toBe(0);
      expect(valueOf(samples, 'jobs_paused', { type: 'operation_recovery' })).toBe(1);
      expect(
        valueOf(samples, 'jobs_lag_seconds', { type: 'operation_recovery' }),
      ).toBeGreaterThanOrEqual(0);
      expect(valueOf(samples, 'operations_unresolved_oldest_age_seconds')).toBeGreaterThanOrEqual(
        120,
      );
      expect(await registry.metrics()).not.toMatch(UUID);
    });

    it('keeps the last values and still answers when the database read fails', async () => {
      let fail = false;
      const flaky = {
        query: (sql: string, params?: unknown[]) =>
          fail ? Promise.reject(new Error('connection refused')) : pool.query(sql, params),
      } as unknown as Pool;
      const registry = createMetricsRegistry('worker');
      registerStateCollector(registry, flaky, logger);
      const first = valueOf(parseMetrics(await registry.metrics()), 'jobs_paused', {
        type: 'operation_recovery',
      });

      fail = true;
      await new Promise((resolve) => setTimeout(resolve, 1_100)); // past the per-scrape reuse window
      const second = valueOf(parseMetrics(await registry.metrics()), 'jobs_paused', {
        type: 'operation_recovery',
      });

      expect(second).toBe(first);
      expect(logs).toContainEqual(expect.objectContaining({ event: 'metrics.collect_failed' }));
    });
  });
});
